import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import { isDeepStrictEqual } from 'node:util'
import { candidateQuerySchema, DashboardError, errorText, type CandidateQuery, type HostObservation } from '../shared/commands.js'
import { unknownRuntime } from '../shared/model.js'
import type { HostCandidate, HostCapture, HostPort, HostProbe, HostSourceSlice, HostTranscript } from './host-port.js'
import { canonicalSourceHeader, digest, integer, LifecycleJournal, object, readLiveGoal, readQuestions, sourceIdentityVariants, type LifecycleEnvironment, type QuestionFact } from './lifecycle.js'
import { questionProjection } from './compat.js'
import { HostArchiveFacts, hostServiceIdentity } from './host-capabilities.js'
import { ReplayFold, ReplayNeedsFullError, ReplayUnavailableError, replaySource, unavailableReplay, REPLAY_EVENT_LIMIT } from './replay-source.js'
import type { SourceReplay } from './event-model.js'
import { buildTranscript } from './transcript.js'

interface CachedJournal { journal: LifecycleJournal; failure: string | null; durableCursor: number; persistenceIdentity: symbol | null }
interface CachedCold { identity: symbol; revision: string; header: SessionHeader; inherited: number; observation: HostObservation; source: SourceReplay | undefined }
interface Wait { agent: Agent; kind: 'input' | 'approval'; release(): void }
interface CachedTitle { corpusVersion: number; stored: string; title: string }
const SOURCE_CHANGED = Symbol('dashboard host source changed')
/** A cold title fold opens the durable log, so independent sessions may overlap. */
const TITLE_READ_CONCURRENCY = 16
/** Bound the in-memory title cache; entries are replaced oldest-first on overflow. */
const TITLE_CACHE_LIMIT = 4096

/** Count the running agents *under* one session: every descendant agent whose
 *  scoped context was created under a member of the root's tree. The root agent
 *  itself is excluded by id, because "running" already says the session is
 *  working and the badge is about extra agents spawned under it. */
export function runningAgentsUnder(registry: { list(): Agent[]; isOwnedBy(id: SessionId, owner: Agent): boolean }, root: Agent): number {
  const all = registry.list(), tree: Agent[] = [root]
  for (let grew = true; grew;) {
    grew = false
    for (const candidate of all) {
      if (tree.includes(candidate)) continue
      if (tree.some(owner => registry.isOwnedBy(candidate.id, owner))) { tree.push(candidate); grew = true }
    }
  }
  return tree.filter(item => item.id !== root.id && item.status === 'running').length
}
/** Passive adapter for supported public host APIs. It never resumes an Agent, sends a
 * prompt, changes a goal, or claims write ownership. A read lease is NOT execution
 * authority: only the exact attached Session/Agent pair can authorize human review. */
export class DshHost implements HostPort {
  private closed = false
  private cache = new WeakMap<Session, CachedJournal>()
  private readonly listeners = new Set<(sessionId: string) => void>()
  private readonly versions = new Map<string, number>()
  private readonly waits = new Set<Wait>()
  private readonly liveApprovals = new WeakMap<Session, Set<string>>()
  private readonly leases = new Set<() => void>()
  private readonly stops: (() => unknown)[] = []
  private readonly archives: HostArchiveFacts
  private corpusVersion = 0
  private readonly titleCache = new Map<string, CachedTitle>()
  private readonly replayCache = new Map<string, { identity: symbol; value: SourceReplay }>()
  private readonly replayFolds = new Map<string, { identity: symbol; fold: ReplayFold; sizeBytes: number | null; verifiedRevision: string | null }>()
  /** Total folded events above, so many long sessions cannot pin unbounded hash chains. */
  private replayFoldEntries = 0
  private readonly coldCaptures = new Map<string, CachedCold>()
  private coldCaptureEntries = 0
  /** Stable over-capacity conclusions keyed to a growing durable artifact. */
  private readonly overCapacity = new Map<string, { identity: symbol; sourceIdentity: string; sizeBytes: number | null }>()
  private replayIdentity: symbol | null = null
  private readonly candidateSources = new Map<object | symbol, number>()
  private nextCandidateSource = 0
  constructor(private readonly ctx: Context) {
    this.archives = new HostArchiveFacts(ctx, id => this.changed(id))
    // Install every invalidation source before the first asynchronous hydration.
    this.stops.push(
      ctx.on('session/event', (session, event) => {
        if (this.closed || ctx.sessions.get(session.id) !== session) return
        try {
          const entry = this.cache.get(session)
          if (entry && entry.failure === null) {
            try { entry.journal.append(event) } catch (error) { entry.failure = errorText(error) }
          }
          if (event.type === 'approval/asked' || event.type === 'approval/decided') {
            const id = object(event.data).id
            if (typeof id === 'string') {
              let pending = this.liveApprovals.get(session)
              if (!pending) { pending = new Set(); this.liveApprovals.set(session, pending) }
              if (event.type === 'approval/asked') pending.add(id)
              else pending.delete(id)
            }
          }
          if (event.type === 'turn/end') this.liveApprovals.delete(session)
        } finally { this.changed(session.id) }
      }),
      ctx.on('session/created', session => { this.changed(session.id) }),
      ctx.on('session/disposed', session => { this.cache.delete(session); this.liveApprovals.delete(session); this.changed(session.id) }),
      ctx.on('agent/created', ({ agent }) => { this.changed(agent.id); return undefined }),
      ctx.on('agent/disposed', ({ agent }) => { for (const wait of [...this.waits]) if (wait.agent === agent) wait.release(); this.changed(agent.id) }),
      ctx.on('agent/status', ({ agent }) => { this.changed(agent.id) }),
      ctx.on('goal/activation-changed', payload => { this.changed(payload.sessionId) }),
      ctx.on('user-questions/request', async (request, next) => {
        const release = request.agent ? this.beginWait(request.agent, 'input', request.signal) : () => {}
        try { return await next() } finally { release() }
      }, { prepend: true }),
      ctx.on('approval/request', async (request, next) => {
        const release = this.beginWait(request.agent, 'approval', request.signal)
        try { return await next() } finally { release() }
      }, { prepend: true }),
    )
  }
  private available(): void { if (this.closed) throw new DashboardError('CLOSED', '宿主生命周期适配器已关闭') }
  private version(id: string): number { return this.versions.get(id) ?? 0 }
  private changed(id: string): void {
    if (this.closed) return
    this.versions.set(id, this.version(id) + 1)
    this.corpusVersion += 1
    for (const listener of this.listeners) {
      // Observers cannot veto a host append or suppress another observer.
      try { listener(id) } catch { /* caller owns reporting its own callback failures */ }
    }
  }
  async transcript(sessionId: string): Promise<HostTranscript> {
    this.available()
    const id = SessionId(sessionId)
    const observation = await this.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    try {
      if (observation.header.id !== id) throw new Error('宿主返回了不同身份的会话')
      return buildTranscript(observation.header, observation.events)
    } finally { observation[Symbol.dispose]() }
  }
  private beginWait(agent: Agent, kind: Wait['kind'], signal?: AbortSignal): () => void {
    if (this.closed || signal?.aborted || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session) return () => {}
    let active = true
    const release = () => {
      if (!active) return
      active = false; this.waits.delete(wait)
      signal?.removeEventListener('abort', release)
      this.changed(agent.id)
    }
    const wait: Wait = { agent, kind, release }
    this.waits.add(wait)
    signal?.addEventListener('abort', release, { once: true })
    this.changed(agent.id)
    return release
  }
  private permitted(header: SessionHeader, agent?: Agent): boolean {
    // parentSession is fork lineage, NOT evidence of delegation. Ordinary user
    // forks remain candidates across workspaces; runtime ownership is separate.
    return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
      && (agent === undefined || this.ctx.agents.roots().some(root => root === agent))
  }
  private checkHeader(header: SessionHeader, id: string, inheritedEventCount: number): void {
    if (header.id !== id) throw new Error('宿主返回了不同身份的会话')
    integer(header.createdAt, 'session creation time')
    integer(inheritedEventCount, 'inherited event count')
    if (header.cwd !== undefined && (typeof header.cwd !== 'string' || header.cwd.length > 4096)) throw new Error('宿主工作区路径无效或过长')
    if (!this.permitted(header)) throw new DashboardError('FORBIDDEN', '子 Agent 会话不能独立纳入仪表板')
  }
  /** Live agents under one session: the main agent plus every descendant created
   *  in its (or a descendant's) scoped context. Runtime ownership is the relation
   *  the registry publishes, so resumed forks never inflate another session. */
  private activeAgents(agent: Agent): number { return runningAgentsUnder(this.ctx.agents, agent) }
  private environment(session: Session, agent: Agent | undefined, questions: readonly QuestionFact[] | null): LifecycleEnvironment {
    const sourceLive = agent !== undefined && agent.session === session && this.permitted(session.header, agent)
    const goals = agent?.ctx.get('goals') ?? this.ctx.get('goals')
    let inputWaits = 0
    let approvalWaits = this.liveApprovals.get(session)?.size ?? 0
    if (sourceLive) for (const wait of this.waits) {
      if (wait.agent !== agent) continue
      if (wait.kind === 'input') inputWaits += 1
      else approvalWaits += 1
    }
    // Queued input can remain parked while public status is idle (inject/maintenance).
    // Read the public Inbox lists, not the concrete AgentLoop-only hasPending getter.
    const pendingInput = sourceLive ? agent.inbox.nextTurn.length + agent.inbox.nextStep.length : 0
    return { sourceLive, status: sourceLive ? agent.status : null,
      goal: sourceLive && goals ? readLiveGoal(goals.get(agent)) : null,
      goalAvailable: goals !== undefined, questions, inputWaits, approvalWaits, pendingInput,
      activeAgents: sourceLive && agent !== undefined ? this.activeAgents(agent) : 0 }
  }
  private liveQuestions(session: Session): readonly QuestionFact[] | null {
    const projection = this.ctx.get('sessionProjections')?.snapshot(session)
    if (projection !== undefined && projection.asOfSeq + 1 !== session.seq) throw new Error('宿主问题投影与日志切面不同步')
    return readQuestions(questionProjection(projection))
  }
  private observation(journal: LifecycleJournal, environment: LifecycleEnvironment, hostArchive: HostObservation['hostArchive']): HostObservation {
    return { runtime: journal.fact(environment), title: journal.title.slice(0, 1000), workspace: journal.header.cwd ?? null, activityAt: journal.activityAt, hostArchive }
  }
  private lease(observation: HostObservation, fence: () => boolean, cleanup: () => void = () => {}, source?: SourceReplay): HostCapture {
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true; this.leases.delete(dispose); cleanup()
    }
    this.leases.add(dispose)
    return { observation, source, validate: () => {
      if (disposed || this.closed) return false
      try { return fence() } catch { return false }
    }, dispose }
  }
  /** Ensure a terminal source survives a host crash BEFORE the dashboard may persist
   * acceptance. Flush uses SessionStore's scope carrier; raw read verifies that an
   * unrelated/no-op flush listener did not manufacture durability for an unstored log. */
  private async durable(session: Session, entry: CachedJournal, persistence: SessionPersistence | undefined, fence: () => boolean): Promise<void> {
    if (!persistence) throw new Error('宿主没有会话持久化服务，不能确认可验收来源的耐久性')
    if (entry.durableCursor === entry.journal.cursor && entry.persistenceIdentity === persistence.identity) return
    const cursor = entry.journal.cursor
    const tail = entry.journal.lastEvent
    if (!await this.ctx.sessions.flush(session)) throw new Error('宿主没有会话耐久性检查点，暂不可验收')
    if (!fence()) throw SOURCE_CHANGED
    const handle = await persistence.open(session.id, 'read')
    try {
      // rc.2 SessionHeader documents omitted delegationDepth as zero. JSONL's
      // writer explicitly materializes that one default; no other field may differ.
      const persistedHeader = { ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }
      const liveHeader = { ...session.header, delegationDepth: session.header.delegationDepth ?? 0 }
      if (!isDeepStrictEqual(persistedHeader, liveHeader) || handle.inheritedEventCount !== session.inheritedEventCount) throw new Error('持久化会话身份或继承边界与当前宿主不同')
      const read = await handle.read(Math.max(0, cursor - 1), 2)
      if (tail === null ? read.events.length !== 0 : read.events.length !== 1 || !isDeepStrictEqual(read.events[0], tail)) throw new Error('宿主当前执行尚未完整写入日志，或持久化来源已变化')
    } finally { await handle.close() }
    if (!fence()) throw SOURCE_CHANGED
    entry.durableCursor = cursor; entry.persistenceIdentity = persistence.identity
  }
  private failure(id: string, error: unknown, missing: boolean, includeReplay = false): HostCapture {
    const session = this.ctx.sessions.get(SessionId(id))
    const agent = this.ctx.agents.get(SessionId(id))
    const version = this.version(id)
    const explanation = `${missing ? '会话不存在或当前不可访问' : '无法可靠读取宿主状态'}：${errorText(error)}`.slice(0, 1000)
    const runtime = unknownRuntime(explanation)
    if (missing) runtime.sync = 'missing'
    runtime.fingerprint = digest({ id, sync: runtime.sync, explanation })
    const archive = this.archives.snapshot()
    return this.lease({ runtime, title: id, workspace: session?.header.cwd ?? null, activityAt: null, hostArchive: archive.fact(id) },
      () => archive.validate() && this.version(id) === version && this.ctx.sessions.get(SessionId(id)) === session && this.ctx.agents.get(SessionId(id)) === agent, () => {}, includeReplay ? { ...unavailableReplay(id, explanation), archiveVersion: archive.version } : undefined)
  }
  private headerIdentity(header: SessionHeader): string { return digest({ header: canonicalSourceHeader(header) }) }
  /** Cheap cache probe: one stat for a cold session, no log open/read. */
  async probe(rawId: string): Promise<HostProbe> {
    this.available()
    const id = SessionId(rawId)
    const archive = this.archives.snapshot()
    const persistence = this.ctx.get('sessionPersistence')
    if (this.ctx.sessions.get(id) !== undefined) {
      const stat = persistence ? await persistence.stat(id).catch(() => undefined) : undefined
      const session = this.ctx.sessions.get(id)
      return { live: true, revision: stat ? String(stat.revision) : undefined, sizeBytes: stat?.sizeBytes ?? null,
        eventCount: stat?.eventCount ?? session?.seq ?? null, hostArchive: archive.fact(rawId) }
    }
    if (!persistence) return { live: false, hostArchive: archive.fact(rawId) }
    try {
      const stat = await persistence.stat(id)
      if (!stat) return { live: false, hostArchive: archive.fact(rawId) }
      return { live: false, headerDigest: this.headerIdentity(stat.header), inherited: stat.header.isSeeded === true ? null : 0,
        revision: String(stat.revision), sizeBytes: stat.sizeBytes ?? null, eventCount: stat.eventCount ?? null, hostArchive: archive.fact(rawId) }
    } catch { return { live: false, hostArchive: archive.fact(rawId) } }
  }
  /** Bounded durable source read for the resumable baseline fold. A live session
   *  is flushed first so every slice observes an exact durable prefix; a cold one
   *  is read without taking write ownership. */
  async readSourceSlice(rawId: string, fromCursor: number, maxEvents: number): Promise<HostSourceSlice> {
    this.available()
    if (!rawId.length || rawId.length > 240) throw new DashboardError('INVALID', '会话身份无效')
    if (!Number.isSafeInteger(fromCursor) || fromCursor < 0) throw new DashboardError('INVALID', '来源游标无效')
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000) throw new DashboardError('INVALID', '来源切片长度无效')
    const id = SessionId(rawId)
    const archive = this.archives.snapshot()
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) throw new DashboardError('UNAVAILABLE', '宿主没有会话持久化服务，不能建立来源基线')
    const session = this.ctx.sessions.get(id)
    if (session !== undefined) {
      if (!await this.ctx.sessions.flush(session)) throw new DashboardError('UNAVAILABLE', '宿主没有会话耐久性检查点，不能建立来源基线')
      this.available()
    }
    const stat = await persistence.stat(id)
    if (!stat) throw new DashboardError('NOT_FOUND', '宿主会话不存在或不可访问')
    const handle = await persistence.open(id, 'read')
    try {
      this.checkHeader(handle.header, id, handle.inheritedEventCount)
      const total = stat.eventCount ?? null
      const start = total === null ? fromCursor : Math.min(fromCursor, total)
      const count = total === null ? maxEvents : Math.min(maxEvents, Math.max(0, total - start))
      const read = count > 0 ? await handle.read(start, count) : { events: [] }
      if (read.events.length > 0 && read.events[0]?.seq !== start) throw new Error('持久化来源切片起点与请求游标不一致')
      for (let index = 1; index < read.events.length; index += 1) {
        if (read.events[index]?.seq !== start + index) throw new Error('持久化来源切片不是连续日志')
      }
      return { header: handle.header, inherited: handle.inheritedEventCount, persistenceIdentity: String(persistence.identity),
        revision: String(stat.revision), total, archiveVersion: archive.version, events: read.events }
    } finally { await handle.close() }
  }
  async capture(rawId: string, includeReplay = false, freshReplay = false): Promise<HostCapture> {
    this.available()
    if (!rawId.length || rawId.length > 240) throw new DashboardError('INVALID', '会话身份无效')
    const id = SessionId(rawId)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.available()
      const session = this.ctx.sessions.get(id)
      try {
        const capture = session ? await this.captureLive(session, includeReplay, freshReplay) : await this.captureCold(id, includeReplay)
        if (capture !== null) return capture
      } catch (error) {
        if (error === SOURCE_CHANGED) continue
        if (error instanceof DashboardError && error.code === 'FORBIDDEN') throw error
        if (this.closed) this.available()
        // A source attached/replaced during a failed cold read must be retried,
        // not cached as missing or unavailable.
        if (this.ctx.sessions.get(id) !== session) continue
        return this.failure(rawId, error, error instanceof SessionPersistenceNotFoundError && session === undefined, includeReplay)
      }
    }
    return this.failure(rawId, new Error('宿主执行来源持续变化，请稍后重新同步'), false, includeReplay)
  }
  private replay(header: SessionHeader, inherited: number, events: readonly SessionEvent[]): SourceReplay {
    try {
      const projections = this.ctx.get('sessionProjections')
      return replaySource(header, inherited, events, prefix => readQuestions(questionProjection(projections?.restore({}, prefix, SessionLogOffset(0), header, SessionLogOffset(inherited)).snapshot)))
    } catch (error) { return unavailableReplay(header.id, `无法验证逐轮来源：${errorText(error)}`) }
  }
  /** Key a replay conclusion to the exact immutable header + inherited cut + durable
   *  revision (+ live seq). The stat revision catches an external rewrite that did not
   *  advance the live sequence. */
  private replayCacheKey(persistence: SessionPersistence, header: SessionHeader, inherited: number, revision: string, seq: number | null): string {
    return digest({ id: header.id, header: { ...header, delegationDepth: header.delegationDepth ?? 0 }, inherited, revision, seq, persistence: String(persistence.identity) })
  }
  private cachedReplay(persistence: SessionPersistence, key: string): SourceReplay | undefined {
    if (this.replayIdentity !== persistence.identity) { this.replayCache.clear(); this.replayFolds.clear(); this.replayFoldEntries = 0; this.overCapacity.clear(); this.replayIdentity = persistence.identity }
    return this.replayCache.get(key)?.value
  }
  private rememberReplay(persistence: SessionPersistence, key: string, value: SourceReplay): void {
    if (this.replayIdentity !== persistence.identity) { this.replayCache.clear(); this.replayFolds.clear(); this.replayFoldEntries = 0; this.overCapacity.clear(); this.replayIdentity = persistence.identity }
    if (value.prefixDigests.length > 20000) return
    if (!this.replayCache.has(key) && this.replayCache.size >= 64) {
      const oldest = this.replayCache.keys().next()
      if (!oldest.done) this.replayCache.delete(oldest.value)
    }
    this.replayCache.set(key, { identity: persistence.identity, value })
  }
  /** Keep one extendable fold per live session. Cached conclusions alone cannot extend:
   *  the journal, digest chain and completion set must survive between captures. */
  private rememberFold(persistence: SessionPersistence, id: string, fold: ReplayFold, sizeBytes: number | null, verifiedRevision: string | null): void {
    if (this.replayIdentity !== persistence.identity) { this.replayCache.clear(); this.replayFolds.clear(); this.replayFoldEntries = 0; this.overCapacity.clear(); this.replayIdentity = persistence.identity }
    const previous = this.replayFolds.get(id)
    if (previous) this.replayFoldEntries -= previous.fold.eventCount
    // Bound retained digest chains by total folded events, not only by session count:
    // a handful of 100k-event folds would otherwise pin tens of megabytes each.
    while (this.replayFolds.size > 0 && (this.replayFolds.size >= 64 || this.replayFoldEntries + fold.eventCount > 500000)) {
      const oldest = this.replayFolds.keys().next()
      if (oldest.done) break
      const evicted = this.replayFolds.get(oldest.value)
      if (evicted) this.replayFoldEntries -= evicted.fold.eventCount
      this.replayFolds.delete(oldest.value)
    }
    this.replayFolds.set(id, { identity: persistence.identity, fold, sizeBytes, verifiedRevision })
    this.replayFoldEntries += fold.eventCount
  }
  private replayIdentityOf(header: SessionHeader, inherited: number): string {
    return sourceIdentityVariants(header, inherited).identity
  }
  private createFold(header: SessionHeader, inherited: number): ReplayFold {
    return new ReplayFold(header, inherited, prefix => {
      const projections = this.ctx.get('sessionProjections')
      return readQuestions(questionProjection(projections?.restore({}, prefix, SessionLogOffset(0), header, SessionLogOffset(inherited)).snapshot))
    })
  }
  private async captureReplay(session: Session, persistence: SessionPersistence | undefined, fence: () => boolean, fresh: boolean): Promise<SourceReplay> {
    if (!persistence) return unavailableReplay(session.id, '宿主没有可读耐久日志，逐轮自动化不可用')
    let key: string | null = null
    try {
      const stat = await persistence.stat(session.id)
      if (stat) key = this.replayCacheKey(persistence, session.header, session.inheritedEventCount, String(stat.revision), session.seq)
      if (key) {
        const cached = this.cachedReplay(persistence, key)
        if (cached) return cached
      }
    } catch { /* stat is an optimization only; the durable read below remains authoritative */ }
    try {
      if (!await this.ctx.sessions.flush(session)) return unavailableReplay(session.id, '宿主没有耐久检查点，逐轮自动化不可用')
      if (!fence()) throw SOURCE_CHANGED
      // A flush may have materialized an unflushed live tail and advanced the durable
      // revision. Cache under the revision the next round will stat, not the pre-flush one.
      let durableCount: number | null = null, durableBytes: number | null = null, durableRevision: string | null = null
      try {
        const stat = await persistence.stat(session.id)
        if (stat) {
          key = this.replayCacheKey(persistence, session.header, session.inheritedEventCount, String(stat.revision), session.seq)
          durableCount = stat.eventCount ?? null
          durableBytes = stat.sizeBytes ?? null
          durableRevision = String(stat.revision)
          // A full reconcile deliberately re-reads a cut that was only trusted via
          // incremental extension; an unchanged cut is still safe to reuse.
          const cached = this.cachedReplay(persistence, key)
          if (cached && (!fresh || this.replayFolds.get(session.id)?.verifiedRevision === durableRevision)) return cached
        }
      } catch { /* the read below is still authoritative */ }
      // An over-capacity cut is a stable conclusion. Avoid opening or hashing a log
      // that can only grow further; the cheap stat above still detects truncation.
      if (durableCount !== null && durableCount > REPLAY_EVENT_LIMIT || durableBytes !== null && durableBytes > 32 * 1024 * 1024)
        return unavailableReplay(session.id, '来源超过单次可靠回放容量，未开放逐轮自动化；请离线维护后显式建立新基线')
      const sourceIdentity = this.replayIdentityOf(session.header, session.inheritedEventCount)
      const over = this.overCapacity.get(session.id)
      if (over && over.identity === persistence.identity && over.sourceIdentity === sourceIdentity
        && (durableBytes === null || over.sizeBytes === null || durableBytes >= over.sizeBytes))
        return unavailableReplay(session.id, '来源超过单次可靠回放容量，未开放逐轮自动化；请离线维护后显式建立新基线')
      if (over) this.overCapacity.delete(session.id)
      // A live Session already owns the immutable event objects; extending the fold
      // from its in-memory tail avoids the persistence read/decode that has no
      // offset-based tail API. The durability barrier above and the completed-cut
      // check in captureLive still guard evidence; only the redundant decode is gone.
      const previous = fresh ? undefined : this.replayFolds.get(session.id)
      if (previous && previous.identity === persistence.identity
        && previous.fold.sourceIdentity === this.replayIdentityOf(session.header, session.inheritedEventCount)) {
        const tail = session.snapshotEvents(SessionLogOffset(previous.fold.cursor), session.seq)
        if (!fence()) throw SOURCE_CHANGED
        const endsAtLive = tail.length === 0 ? previous.fold.cursor === session.seq : tail.at(-1)?.seq === session.seq - 1
        if (endsAtLive && (tail.length === 0 || tail[0]?.seq === previous.fold.cursor)) {
          try {
            const value = previous.fold.append(tail, undefined)
            if (value.coverage === 'complete') {
              this.overCapacity.delete(session.id)
              if (key) this.rememberReplay(persistence, key, value)
              this.rememberFold(persistence, session.id, previous.fold, durableBytes ?? previous.sizeBytes, previous.verifiedRevision)
              return value
            }
          } catch (error) {
            if (!(error instanceof ReplayNeedsFullError) && !(error instanceof ReplayUnavailableError)) throw error
          }
        }
      }
      let value: SourceReplay | null = null
      const events = session.snapshotEvents(SessionLogOffset(0), session.seq)
      if (!fence()) throw SOURCE_CHANGED
      if (events.length !== session.seq) {
        this.replayFolds.delete(session.id)
        return unavailableReplay(session.id, '宿主未完整持久化当前日志，逐轮自动化已暂停')
      }
      const fold = this.createFold(session.header, session.inheritedEventCount)
      value = fold.append(events, cursor => events.slice(0, cursor))
      if (value.coverage === 'complete') {
        this.overCapacity.delete(session.id)
        if (!fold.requiresQuestionProjection()) this.rememberFold(persistence, session.id, fold, durableBytes, durableRevision)
        else this.replayFolds.delete(session.id)
      } else {
        this.replayFolds.delete(session.id)
        if (value.reason?.includes('容量')) this.overCapacity.set(session.id, { identity: persistence.identity, sourceIdentity, sizeBytes: durableBytes })
      }
      if (key && value) this.rememberReplay(persistence, key, value)
      return value ?? unavailableReplay(session.id, '无法读取逐轮耐久来源')
    } catch (error) {
      if (error === SOURCE_CHANGED) throw error
      // A journal/fold error leaves the retained chain suspect; rebuild it next time.
      this.replayFolds.delete(session.id)
      return unavailableReplay(session.id, `读取逐轮耐久来源失败：${errorText(error)}`)
    }
  }
  private async captureLive(session: Session, includeReplay: boolean, freshReplay: boolean): Promise<HostCapture | null> {
    const id = session.id
    const agent = this.ctx.agents.get(id)
    const version = this.version(id)
    const persistence = this.ctx.get('sessionPersistence')
    const archive = this.archives.snapshot()
    let source: SessionObservation | null = null
    try {
      source = await this.ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })
      if (this.closed) throw new DashboardError('CLOSED', '宿主生命周期适配器已关闭')
      if (source.source !== 'live' || this.ctx.sessions.get(id) !== session || this.ctx.agents.get(id) !== agent || source.header !== session.header || source.cursor + 1 !== session.seq || this.version(id) !== version) return null
      this.checkHeader(source.header, id, source.inheritedEventCount)
      if (agent && !this.permitted(source.header, agent)) throw new DashboardError('FORBIDDEN', '委派 Agent 会话不能独立纳入仪表板')
      let entry = this.cache.get(session)
      if (!entry || entry.failure !== null || entry.journal.cursor !== source.cursor + 1) {
        const journal = new LifecycleJournal(source.header, source.inheritedEventCount)
        for (const event of source.events) journal.append(event)
        if (journal.cursor !== source.cursor + 1 || journal.inheritedEventCount > journal.cursor) throw new Error('宿主会话日志与观察游标不一致')
        entry = { journal, failure: null, durableCursor: -1, persistenceIdentity: null }
        this.cache.set(session, entry)
      }
      const questions = readQuestions(questionProjection(source.projections))
      const environment = this.environment(session, agent, questions)
      const signature = digest(environment)
      const cursor = session.seq
      const fence = () => archive.validate() && this.version(id) === version && this.ctx.sessions.get(id) === session && this.ctx.agents.get(id) === agent
        && session.seq === cursor && this.ctx.get('sessionPersistence')?.identity === persistence?.identity
        && signature === digest(this.environment(session, agent, this.liveQuestions(session)))
      if (!fence()) return null
      let observation = this.observation(entry.journal, environment, archive.fact(id))
      if (!environment.sourceLive) {
        observation.runtime = { ...observation.runtime, sync: 'unknown', phase: 'unknown', attention: 'sync', explanation: '当前会话没有匹配的本地 Agent 所有者，无法可靠核对执行；请进入原会话并重试' }
        observation.runtime.fingerprint = digest({ ...observation.runtime, cursor: undefined })
      } else if (observation.runtime.sync === 'synced' && (observation.runtime.phase === 'completed' || observation.runtime.phase === 'not_started')) {
        try { await this.durable(session, entry, persistence, fence) }
        catch (error) {
          if (error === SOURCE_CHANGED) return null
          observation = { ...observation, runtime: { ...observation.runtime, sync: 'unknown', attention: 'sync', explanation: `宿主执行日志耐久性尚未确认：${errorText(error)}`.slice(0, 1000) } }
          observation.runtime.fingerprint = digest({ phase: observation.runtime.phase, sync: 'unknown', episode: observation.runtime.episodeId, reason: observation.runtime.explanation })
        }
      }
      const replay = includeReplay ? await this.captureReplay(session, persistence, fence, freshReplay) : undefined
      if (!fence()) return null
      const retained = source
      source = null
      return this.lease(observation, fence, () => retained[Symbol.dispose](), replay ? { ...replay, archiveVersion: archive.version } : undefined)
    } finally { source?.[Symbol.dispose]() }
  }
  private rememberCold(id: string, entry: CachedCold): void {
    const previous = this.coldCaptures.get(id)
    if (previous) this.coldCaptureEntries -= previous.source?.prefixDigests.length ?? 0
    const entries = entry.source?.prefixDigests.length ?? 0
    while (this.coldCaptures.size > 0 && (this.coldCaptures.size >= 64 || this.coldCaptureEntries + entries > 500000)) {
      const oldest = this.coldCaptures.keys().next()
      if (oldest.done) break
      const evicted = this.coldCaptures.get(oldest.value)
      if (evicted) this.coldCaptureEntries -= evicted.source?.prefixDigests.length ?? 0
      this.coldCaptures.delete(oldest.value)
    }
    this.coldCaptures.set(id, entry)
    this.coldCaptureEntries += entries
  }
  private async captureCold(id: SessionId, includeReplay: boolean): Promise<HostCapture | null> {
    const version = this.version(id)
    const agent = this.ctx.agents.get(id)
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) throw new Error('当前宿主没有会话持久化服务；不能将能力缺失当作会话不存在')
    const archive = this.archives.snapshot()
    // A cold session with an unchanged durable revision has unchanged facts. Reuse the
    // last observation while re-reading only the independent archive fact; the 15 s
    // reconcile otherwise re-reads and re-folds every large cold log forever.
    const stat = await persistence.stat(id).catch(() => undefined)
    const cached = stat ? this.coldCaptures.get(id) : undefined
    if (stat && cached && cached.identity === persistence.identity && cached.revision === String(stat.revision)
      && isDeepStrictEqual({ ...cached.header, delegationDepth: cached.header.delegationDepth ?? 0 }, { ...stat.header, delegationDepth: stat.header.delegationDepth ?? 0 })
      && (!includeReplay || cached.source !== undefined)) {
      this.checkHeader(cached.header, id, cached.inherited)
      if (this.closed) this.available()
      if (!archive.validate() || this.ctx.sessions.get(id) !== undefined || this.ctx.agents.get(id) !== agent || this.version(id) !== version) return null
      const observation = { ...cached.observation, hostArchive: archive.fact(id) }
      return this.lease(observation, () => archive.validate() && this.ctx.sessions.get(id) === undefined && this.ctx.agents.get(id) === agent
        && this.version(id) === version && this.ctx.get('sessionPersistence')?.identity === persistence.identity, () => {},
      includeReplay && cached.source ? { ...cached.source, archiveVersion: archive.version } : undefined)
    }
    // Never use a prepared Session observation here: rc.2 cold preparation balances
    // an open turn with synthetic interrupted closers and a non-durable cursor.
    const handle = await persistence.open(id, 'read')
    let journal: LifecycleJournal
    let replay: SourceReplay | undefined
    let questions: readonly QuestionFact[] | null
    try {
      this.checkHeader(handle.header, id, handle.inheritedEventCount)
      const read = await handle.read()
      journal = new LifecycleJournal(handle.header, handle.inheritedEventCount)
      for (const event of read.events) journal.append(event)
      if (journal.inheritedEventCount > journal.cursor) throw new Error('持久化继承边界超过原始日志长度')
      const projection = this.ctx.get('sessionProjections')?.restore({}, read.events, SessionLogOffset(0), handle.header, handle.inheritedEventCount).snapshot
      if (projection && projection.asOfSeq + 1 !== journal.cursor) throw new Error('持久化问题投影与原始日志游标不一致')
      questions = readQuestions(questionProjection(projection))
      if (includeReplay) replay = this.replay(handle.header, handle.inheritedEventCount, read.events)
    } finally { await handle.close() }
    if (this.closed) this.available()
    if (!archive.validate() || this.ctx.sessions.get(id) !== undefined || this.ctx.agents.get(id) !== agent || this.version(id) !== version) return null
    const observation = this.observation(journal, { sourceLive: false, status: null, goal: null, goalAvailable: false, questions, inputWaits: 0, approvalWaits: 0, pendingInput: 0, activeAgents: 0 }, archive.fact(id))
    if (stat) this.rememberCold(id, { identity: persistence.identity, revision: String(stat.revision), header: { ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, inherited: handle.inheritedEventCount, observation, source: replay })
    // A read handle proves a durable prefix, never that another process has not
    // started a new turn. sourceLive=false is mandatory and review rejects it.
    return this.lease(observation, () => archive.validate() && this.ctx.sessions.get(id) === undefined && this.ctx.agents.get(id) === agent
      && this.version(id) === version && this.ctx.get('sessionPersistence')?.identity === persistence.identity, () => {}, replay ? { ...replay, archiveVersion: archive.version } : undefined)
  }
  /** Fold the latest log-backed title for exactly these sessions. Each cold session
   * re-opens its durable log per read, so a text is cached against the corpus
   * generation AND that session's stored revision: every change that can change the
   * candidate generation also discards the cached text, while repeated queries and
   * later pages do not re-read the same logs. A failed fold rejects the whole
   * listing; it is never cached, and it never becomes an empty row. */
  private async foldTitles(engine: SessionQueryEngine, records: readonly SessionRecord[], version: number, stored: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    const pending: SessionRecord[] = []
    for (const record of records) {
      const id = record.header.id
      const cached = this.titleCache.get(id)
      if (cached !== undefined && cached.corpusVersion === version && cached.stored === (stored.get(id) ?? '')) titles.set(id, cached.title)
      else pending.push(record)
    }
    for (let start = 0; start < pending.length; start += TITLE_READ_CONCURRENCY) {
      const batch = await Promise.all(pending.slice(start, start + TITLE_READ_CONCURRENCY).map(async record => {
        const id = record.header.id
        const snapshot = await engine.readTitle(id)
        this.available()
        // "No logged title" is a fact, not a failure: report the identity, never ''.
        return { id, stored: stored.get(id) ?? '', title: (snapshot?.title.trim() ? snapshot.title : id).slice(0, 1000) }
      }))
      for (const entry of batch) {
        titles.set(entry.id, entry.title)
        this.rememberTitle(entry.id, { corpusVersion: version, stored: entry.stored, title: entry.title })
      }
      this.available()
    }
    return titles
  }
  private rememberTitle(id: string, entry: CachedTitle): void {
    if (!this.titleCache.has(id) && this.titleCache.size >= TITLE_CACHE_LIMIT) {
      const oldest = this.titleCache.keys().next()
      if (!oldest.done) this.titleCache.delete(oldest.value)
    }
    this.titleCache.set(id, entry)
  }
  private candidateSource(identity: object | symbol): number {
    const known = this.candidateSources.get(identity)
    if (known !== undefined) return known
    const value = ++this.nextCandidateSource
    this.candidateSources.set(identity, value)
    return value
  }
  async list(raw: CandidateQuery, membership?: ReadonlySet<string>): Promise<{ items: HostCandidate[]; total: number; nextOffset: number | null; generation: string }> {
    this.available()
    const query = candidateQuerySchema.parse(raw)
    const memberFilter = query.membership ?? 'all'
    // The service supplies the product defaults. Omitted internal conditions retain
    // the legacy complete-corpus behavior; an explicit active filter never treats
    // unknown/unsupported archive data as active.
    const archiveFilter = query.hostArchive ?? 'all'
    if (memberFilter !== 'all' && membership === undefined) throw new DashboardError('UNAVAILABLE', '看板成员来源不可用，不能将未知成员集合当作空集合')
    const members = membership === undefined ? null : [...membership].sort()
    const memberSet = members === null ? null : new Set(members)
    const needle = query.search.normalize('NFKC').toLocaleLowerCase()
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        this.available()
        const engine = this.ctx.get('sessionQuery')
        const persistence = this.ctx.get('sessionPersistence')
        if (!engine || !persistence) throw new DashboardError('UNAVAILABLE', '宿主完整会话来源不可用，不能将仅有的活动会话当作完整候选')
        const engineIdentity = hostServiceIdentity(engine)
        const persistenceIdentity = persistence.identity
        const version = this.corpusVersion
        const archive = this.archives.snapshot()
        const archiveCapability = archive.fact('')
        if (archiveFilter !== 'all' && (archiveCapability.state === 'unknown' || archiveCapability.state === 'unsupported')) throw new DashboardError('UNAVAILABLE', archiveCapability.reason ?? '宿主归档条件不可用')
        // Public persistence revisions bind cold titles to the same corpus cut.
        // Header-only listSessions alone cannot notice a cold log title changing.
        const stored = await persistence.list()
        const storageSignature = digest(stored)
        const corpus = await engine.listSessions()
        const corpusSignature = digest(corpus)
        // One comparable token per stored session, so a cold title cache entry is
        // discarded exactly when that session's durable revision changes.
        const storedTokens = new Map<string, string>()
        for (const snapshot of stored) storedTokens.set(snapshot.header.id, JSON.stringify(snapshot))
        const rows = corpus.filter(row => this.permitted(row.header, this.ctx.agents.get(row.header.id)))
        if (new Set(rows.map(row => row.header.id)).size !== rows.length) throw new Error('宿主候选返回重复会话身份')
        // Identity, ordering, membership and archive facts are title-independent.
        // SessionRecord exposes identity/availability, not latest activity: ordering
        // uses the header, so enriching page one cannot reorder page two.
        const ordered = rows.map(record => { this.checkHeader(record.header, record.header.id, 0); return { record, createdAt: record.header.createdAt } })
        ordered.sort((a, b) => b.createdAt - a.createdAt || a.record.header.id.localeCompare(b.record.header.id))
        const filtered = ordered.filter(({ record }) => (memberFilter === 'all' || memberSet?.has(record.header.id) === (memberFilter === 'tracked'))
          && (archiveFilter === 'all' || archive.fact(record.header.id).state === archiveFilter))
        // Bind even excluded corpus identities and archive/member conditions. A
        // later page cannot silently reuse an offset after any relevant change.
        const baseGeneration = digest({ corpus, stored: storageSignature, archive: archive.generation, members, memberFilter, archiveFilter, needle, engineIdentity: this.candidateSource(engineIdentity), persistenceIdentity: this.candidateSource(persistenceIdentity) })
        if (!needle && query.generation !== undefined && query.generation !== null && query.generation !== baseGeneration) throw new DashboardError('CONFLICT', '宿主候选、成员或归档条件已变化，请从第一页重新查询')
        // A search compares titles, so it must fold every filtered title; an unsearched
        // page needs only the titles of the exact window it returns. Neither path folds
        // the whole corpus on every call, and both reuse the bounded title cache.
        const window = filtered.slice(query.offset, query.offset + query.limit)
        const titles = await this.foldTitles(engine, needle ? filtered.map(row => row.record) : window.map(row => row.record), version, storedTokens)
        this.available()
        const matching = needle ? filtered.filter(({ record }) => [titles.get(record.header.id) ?? record.header.id, record.header.cwd ?? '', record.header.id].some(value => value.normalize('NFKC').toLocaleLowerCase().includes(needle))) : filtered
        // A title match decides the result set itself, so a searched page must bind the
        // exact folded titles that produced its filtering. An unsearched result set never
        // depends on title text (titles are read for display only).
        const generation = needle
          ? digest({ base: baseGeneration, titles: filtered.map(({ record }) => [record.header.id, titles.get(record.header.id) ?? record.header.id]) })
          : baseGeneration
        if (query.generation !== undefined && query.generation !== null && query.generation !== generation) throw new DashboardError('CONFLICT', '宿主候选、成员或归档条件已变化，请从第一页重新查询')
        // Captures are intentionally NOT taken here: a candidate row carries no runtime
        // enrichment, and only inspectSession owns the authoritative observation.
        const [currentCorpus, currentStored] = await Promise.all([engine.listSessions(), persistence.list()])
        const currentEngine = this.ctx.get('sessionQuery')
        if (!archive.validate() || this.corpusVersion !== version || currentEngine === undefined || hostServiceIdentity(currentEngine) !== engineIdentity
          || this.ctx.get('sessionPersistence')?.identity !== persistenceIdentity || digest(currentCorpus) !== corpusSignature || digest(currentStored) !== storageSignature) continue
        const items = matching.slice(query.offset, query.offset + query.limit).map(({ record }): HostCandidate => ({ sessionId: record.header.id,
          title: (titles.get(record.header.id) ?? record.header.id).slice(0, 1000), workspace: record.header.cwd ?? null, activityAt: null,
          hostArchive: archive.fact(record.header.id) }))
        return { items, total: matching.length, nextOffset: query.offset + items.length < matching.length ? query.offset + items.length : null, generation }
      }
      throw new DashboardError('CONFLICT', '宿主候选来源持续变化，请从第一页重新查询')
    } catch (error) {
      if (error instanceof DashboardError) throw error
      throw new DashboardError('UNAVAILABLE', `无法枚举宿主会话（没有将读取失败当成空列表）：${errorText(error)}`)
    }
  }
  subscribe(listener: (sessionId: string) => void): () => void {
    this.available(); this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.archives.close()
    for (const stop of this.stops.splice(0)) stop()
    for (const wait of [...this.waits]) wait.release()
    for (const dispose of [...this.leases]) dispose()
    this.listeners.clear(); this.versions.clear(); this.candidateSources.clear(); this.titleCache.clear(); this.replayCache.clear(); this.replayFolds.clear(); this.replayFoldEntries = 0; this.overCapacity.clear(); this.coldCaptures.clear(); this.coldCaptureEntries = 0; this.cache = new WeakMap()
  }
}
export function createDshHost(ctx: Context): HostPort { return new DshHost(ctx) }
