import { randomUUID } from 'node:crypto'
import { EMPTY, statusSchema, unknownHostArchive, unknownRuntime, type Board, type Card, type Dimension, type Health, type Label, type Project, type StateSnapshot, type Snapshot } from '../shared/model.js'
import { candidateQuerySchema, mutationSchema, navigationQuerySchema, observationSchema, errorText, fail, type NavigationQuery, type NavigationResult, type CandidatePage, type CandidateQuery, type Command, type HostObservation, type Mutation, inspectionQuerySchema, type InspectionQuery, type SessionInspection, type SessionInspectionBinding, type WorkflowBinding, type StateTarget, type StateSelection, type HistoryQuery, type HistoryPage, historyQuerySchema } from '../shared/commands.js'
import { transcriptQuerySchema, type Transcript, type TranscriptQuery } from '../shared/transcript.js'
import type { HostCapture, HostPort, HostProbe } from './host-port.js'
import { BaselineManager } from './baseline-manager.js'
import type { BoardStore, ColdCheckpoint, StoreSnapshot } from './store.js'
import { digestCommand } from './store.js'
import { applyObservation } from './progress.js'
import { unavailableReplay } from './replay-source.js'
import { makeWitness, sourceCut } from './workflow.js'
import type { SourceReplay } from './event-model.js'

type Fence = () => void
export interface DashboardServiceOptions {
  /** A session at or above either bound uses the resumable baseline instead of
   *  re-folding its whole durable log on every observation. */
  baselineEvents?: number
  baselineBytes?: number
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const normalized = (name: string) => name.normalize('NFKC').toLocaleLowerCase()
function cardFor(board: Board, sessionId: string): Card { return board.cards.find(card => card.sessionId === sessionId) ?? fail('NOT_FOUND', '会话已移出看板，请刷新') }
function assertMetadata(card: Card, expected: number): void { if (card.metadataRevision !== expected) fail('CONFLICT', '此会话已在其他窗口修改；请刷新后重试，输入草稿仍可保留') }
function assertMembership(card: Card, membershipId: string): void { if (card.membershipId !== membershipId) fail('CONFLICT', 'Membership changed; inspect the session again') }
function assertWorkflow(card: Card, binding: WorkflowBinding): void {
  assertMembership(card, binding.membershipId); assertMetadata(card, binding.expectedMetadataRevision)
  if (card.lifecycleRevision !== binding.expectedLifecycleRevision || card.workflowRevision !== binding.expectedWorkflowRevision || card.runtime.episodeId !== binding.episodeId) fail('REVIEW_STALE', 'Execution or workflow changed; review the current session again')
}
/** Arranging a work state is not a review decision: a benign cursor/title or
 *  runtime fact update between snapshot and capture must not invalidate it. The
 *  exact workflow placement and the post-capture state eligibility are still
 *  checked, and acceptance/review keeps the full lifecycle CAS. */
function assertStateWorkflow(card: Card, binding: WorkflowBinding): void {
  assertMembership(card, binding.membershipId); assertMetadata(card, binding.expectedMetadataRevision)
  if (card.workflowRevision !== binding.expectedWorkflowRevision) fail('REVIEW_STALE', 'Work state changed; verify the current placement and retry')
}
function projectFor(board: Board, id: string, revision?: number): Project {
  const project = board.projects.find(row => row.id === id) ?? fail('NOT_FOUND', 'Project no longer exists')
  if (revision !== undefined && project.revision !== revision) fail('CONFLICT', 'Project configuration changed')
  return project
}
function validateTags(board: Board, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length || ids.some(id => !board.tags.some(row => row.id === id))) fail('INVALID', 'Tags are duplicated or unavailable')
  // One value per group: an ungrouped tag is its own bucket, project values are a
  // group too, so a card can never hold two answers to the same question.
  const seen = new Set<string>()
  for (const id of ids) {
    const bucket = board.tags.find(row => row.id === id)?.groupId ?? EMPTY
    if (seen.has(bucket)) fail('INVALID', '同一标签组只能选择一个值')
    seen.add(bucket)
  }
}
const RESERVED_STATUS_NAMES = ['进行中', '待确认', '待验收', '已验收', 'in progress', 'pending confirm', 'awaiting confirmation', 'pending review', 'awaiting review']
const reservedStates = new Set([...statusSchema.options, ...RESERVED_STATUS_NAMES])
function assertStateName(rows: Label[], name: string, except?: string): void { if (reservedStates.has(normalized(name))) fail('INVALID', 'Custom state cannot use a reserved built-in name'); assertName(rows, name, except) }
function targetStatus(board: Board, target: StateTarget): StateSnapshot {
  const status = board.statuses.find(row => row.id === target.statusId) ?? fail('NOT_FOUND', '状态不存在')
  if (status.revision !== target.expectedStatusRevision) fail('CONFLICT', '目标状态已修改，请刷新')
  return { statusId: status.id, statusName: status.name, statusRevision: status.revision }
}
function assertEditable(card: Card): void { if (card.archivedAt !== null) fail('INVALID', '归档会话只读，请先恢复') }
function assertClassification(board: Board, projectId: string | null): void {
  if (projectId !== null && !board.projects.some(label => label.id === projectId)) fail('NOT_FOUND', '项目不存在')
}
function assertName(rows: readonly { id: string; name: string }[], name: string, except?: string): void {
  if (rows.some(label => label.id !== except && normalized(label.name) === normalized(name))) fail('INVALID', '该维度中已经存在同名标签')
}
function appendOrder(board: Board, dimension: Dimension, id: string): void {
  const order = board.orders[dimension]
  const at = order.ids.at(-1) === EMPTY ? order.ids.length - 1 : order.ids.length
  order.ids.splice(at, 0, id); order.revision += 1
}
function initialCard(sessionId: string, projectId: string | null, observation: HostObservation, now: number): Card {
  const card: Card = { sessionId, membershipId: randomUUID(), hostArchive: observation.hostArchive, hostTitle: sessionId, titleOverride: null, workspace: null, projectId, tagIds: [], progress: '', status: 'in_progress', runtime: unknownRuntime(), decision: null, joinedAt: now, activityAt: null, updatedAt: now, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0, workflowRevision: 0, placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null }
  applyObservation(card, observation, now)
  if (!card.hostTitle || card.hostTitle === sessionId) card.hostTitle = observation.title
  card.workspace = observation.workspace
  return card
}

/** The queue coordinates captures with mutations and unload. SQLite is the cross-process
 * authority; independent metadata/lifecycle revisions avoid unrelated updates overwriting work. */
export class DashboardService {
  readonly serviceId = randomUUID()
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly dirty = new Set<string>()
  private tracked = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private scheduled = false
  private eventGeneration = 0
  private readonly syncErrors = new Map<string, string>()
  private lastReconcileAt = 0
  private readonly baseline: BaselineManager
  private readonly baselineEvents: number
  private readonly baselineBytes: number
  private readonly baselineSessions = new Set<string>()
  private health: Health = { state: 'ready', message: null, lastSyncAt: null }
  constructor(private readonly store: BoardStore, private readonly host: HostPort, private readonly report: (error: unknown) => void = () => {}, private readonly now: () => number = Date.now, options: DashboardServiceOptions = {}) {
    this.baselineEvents = options.baselineEvents ?? 5000
    this.baselineBytes = options.baselineBytes ?? 8 * 1024 * 1024
    this.tracked = new Set(store.read().cards.map(card => card.sessionId))
    // Subscribe before the first hydrate. Event callbacks only mark dirty: no reentrant host append/write.
    this.unsubscribe = host.subscribe(sessionId => {
      if (this.closed || !this.tracked.has(sessionId)) return
      this.dirty.add(sessionId)
      this.eventGeneration += 1
      this.scheduleReconcile()
    })
    this.timer = setInterval(() => { if (!this.closed) void this.enqueue(() => this.reconcile(true)).catch(this.report) }, 15000)
    this.timer.unref()
    this.baseline = new BaselineManager(host, store, { onProgress: sessionId => {
      // Baseline progress is source evidence, not a new execution fact. Record it
      // without an observation commit, so a background fold never bumps a human
      // workflow binding or lifecycle revision on its own.
      if (this.closed) return
      const card = this.store.read().cards.find(row => row.sessionId === sessionId)
      if (!card) return
      const source = this.baseline.peek(sessionId, card.runtime.cursor)
      if (!source) return
      try { this.store.commit(null, () => false, undefined, [source]) } catch (error) { this.report(error) }
    } })
  }
  private scheduleReconcile(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    queueMicrotask(() => {
      if (this.closed) { this.scheduled = false; return }
      const generation = this.eventGeneration
      void this.enqueue(() => this.reconcile(false)).catch(this.report).finally(() => {
        this.scheduled = false
        // Retry only newly arrived events, not permanent failures in a busy loop.
        if (!this.closed && this.dirty.size && generation !== this.eventGeneration) this.scheduleReconcile()
      })
    })
  }
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Dashboard closed'))
    const result = this.chain.then(() => { if (this.closed) fail('CLOSED', '仪表板已关闭'); return work() })
    this.chain = result.catch(() => {})
    return result
  }
  /** One transaction-consistent cut for both UI and readonly consumers. A failed
   * write cannot persist its own warning, so revoke that member's freshness in
   * both views without changing historical origin or unrelated healthy members. */
  private effectiveStoreSnapshot(): StoreSnapshot {
    const stored = this.store.snapshot(), board = stored.board
    this.tracked = new Set(board.cards.map(card => card.sessionId))
    this.updateHealth(board)
    const summaries = new Map(stored.cards.map(card => [card.membershipId, card]))
    for (const card of board.cards) {
      const error = this.syncErrors.get(card.sessionId)
      if (error) card.runtime = { ...card.runtime, sync: 'unknown', sourceLive: false, explanation: error, attention: 'sync' }
      const summary = summaries.get(card.membershipId) ?? fail('STORAGE', 'Store snapshot is missing a membership summary')
      summary.sync = card.runtime.sync
      summary.sourceLive = card.runtime.sourceLive
      summary.phase = card.runtime.phase
      summary.attention = card.runtime.attention
      // Durable replay coverage is independent of current live ownership: a cold,
      // synced raw journal retains complete evidence but never live review authority.
      // Ephemeral write failures already project sync=unknown above, so both readonly
      // and UI consumers still withdraw coverage on the same failed source cut.
      if (card.runtime.sync !== 'synced') {
        summary.sourceLive = false
        summary.completionCoverage = 'unavailable'
        summary.completionEvidenceDigest = null
      }
    }
    return stored
  }
  private snapshotValue(): Snapshot {
    const stored = this.effectiveStoreSnapshot()
    const baseline: NonNullable<Snapshot['baseline']> = []
    for (const card of stored.board.cards) {
      const progress = this.baseline.status(card.sessionId)
      if (progress.state === 'idle') continue
      baseline.push({ sessionId: card.sessionId, state: progress.state, cursor: progress.cursor, total: progress.total, reason: progress.reason })
    }
    return { board: stored.board, health: { ...this.health }, memberGenerations: stored.cards.map(card => ({ membershipId: card.membershipId, cancellationGeneration: card.cancellationGeneration })), baseline }
  }
  private updateHealth(board: Board): void {
    const ids = new Set(board.cards.map(card => card.sessionId))
    for (const id of this.syncErrors.keys()) if (!ids.has(id)) this.syncErrors.delete(id)
    const unavailable = board.cards.filter(card => card.runtime.sync !== 'synced' || this.syncErrors.has(card.sessionId))
    this.health = {
      state: unavailable.length ? 'degraded' : 'ready',
      message: unavailable.length ? unavailable.slice(0, 3).map(card => `${card.sessionId}: ${this.syncErrors.get(card.sessionId) ?? card.runtime.explanation ?? '状态待同步'}`).join('\n') : null,
      lastSyncAt: this.health.lastSyncAt,
    }
  }
  private async observe(sessionId: string, includeReplay = true, freshReplay = false): Promise<HostCapture> {
    // Never cache one capture as current authority across operations.
    const capture = await this.host.capture(sessionId, includeReplay, freshReplay)
    try { observationSchema.parse(capture.observation); return capture }
    catch (error) { capture.dispose(); throw error }
  }
  /** Long sessions use the resumable baseline; short ones keep the established
   *  inline replay so their workflow bindings stay byte-for-byte unchanged. */
  private async useBaseline(sessionId: string, probe?: HostProbe | null): Promise<boolean> {
    if (this.host.readSourceSlice === undefined) return false
    if (this.baselineSessions.has(sessionId)) return true
    try { if (this.store.sourceFold(sessionId) !== null) { this.baselineSessions.add(sessionId); return true } } catch { return false }
    let current = probe
    if (current === undefined && this.host.probe) current = await this.host.probe(sessionId).catch(() => null)
    const large = current !== null && current !== undefined
      && ((current.eventCount ?? 0) >= this.baselineEvents || (current.sizeBytes ?? 0) >= this.baselineBytes)
    if (large) this.baselineSessions.add(sessionId)
    return large
  }
  /** Attach the managed compact source when it already reaches the observation
   *  cursor. Never waits for a long first baseline. */
  private async attachSource(capture: HostCapture, sessionId: string): Promise<HostCapture> {
    if (!await this.useBaseline(sessionId)) return capture
    const result = await this.baseline.source(sessionId, capture.observation.runtime.cursor)
    if (result.state === 'ready' && result.source) return { ...capture, source: result.source }
    this.baseline.ensure(sessionId)
    return capture
  }
  /** A source-dependent human decision needs a complete cut reaching the live
   *  observation. A running baseline is reported inline instead of blocking the
   *  whole dashboard queue. */
  private async requireSource(capture: HostCapture, sessionId: string, action: string): Promise<HostCapture> {
    if (!await this.useBaseline(sessionId)) {
      if (!capture.source || capture.source.coverage !== 'complete') fail('UNAVAILABLE', `A complete source is required to ${action}`)
      return capture
    }
    const result = await this.baseline.source(sessionId, capture.observation.runtime.cursor)
    if (result.state === 'ready' && result.source) return { ...capture, source: result.source }
    const progress = result.total !== null && result.total > 0 ? `（已处理 ${result.cursor}/${result.total}）` : ''
    fail('UNAVAILABLE', result.state === 'running' ? `来源基线正在后台建立${progress}，完成后可${action}` : `来源基线不可用：${result.reason ?? '未知原因'}`)
  }
  /** A cold observation is reusable only for the exact stored lifecycle and
   *  durable revision; anything else falls back to a real log read. */
  private checkpointMatches(checkpoint: ColdCheckpoint, probe: HostProbe): boolean {
    return probe.live === false && probe.headerDigest !== undefined && probe.revision !== undefined
      && checkpoint.headerDigest === probe.headerDigest && checkpoint.revision === probe.revision
      && checkpoint.inherited === (probe.inherited ?? null)
      && (checkpoint.sizeBytes === null || probe.sizeBytes === null || probe.sizeBytes === undefined || checkpoint.sizeBytes === probe.sizeBytes)
  }
  private async reconcile(all: boolean): Promise<void> {
    const board = this.store.read()
    this.tracked = new Set(board.cards.map(card => card.sessionId))
    for (const id of this.dirty) if (!this.tracked.has(id)) this.dirty.delete(id)
    const ids = board.cards.filter(card => all || this.dirty.has(card.sessionId)).map(card => card.sessionId)
    if (!ids.length) {
      if (all) { this.lastReconcileAt = this.now(); if (board.cards.every(card => card.runtime.sync === 'synced')) this.health.lastSyncAt = this.now() }
      this.updateHealth(board); return
    }
    // Bounded batches prevent hundreds of cold journals being read at once.
    for (let start = 0; start < ids.length; start += 4) {
      const results = await Promise.all(ids.slice(start, start + 4).map(async sessionId => {
        let probe: HostProbe | null = null
        try {
          probe = this.host.probe ? await this.host.probe(sessionId) : null
          const bounded = await this.useBaseline(sessionId, probe)
          if (probe && !probe.live) {
            const cached = this.store.coldCheckpoint(sessionId)
            if (cached && this.checkpointMatches(cached, probe)) {
              const observation = { ...cached.observation, hostArchive: probe.hostArchive }
              const source = this.baseline.peek(sessionId, observation.runtime.cursor)
              if (!source && bounded) this.baseline.ensure(sessionId)
              return { sessionId, capture: null, observation, source, cached, probe, error: null }
            }
          }
          const capture = await this.observe(sessionId, !bounded)
          let source = capture.source
          if (bounded) {
            source = this.baseline.peek(sessionId, capture.observation.runtime.cursor) ?? undefined
            if (!source) this.baseline.ensure(sessionId)
          }
          return { sessionId, capture, observation: null, source, cached: null, probe, error: null }
        } catch (error) { return { sessionId, capture: null, observation: null, source: undefined, cached: null, probe, error } }
      }))
      for (const result of results) {
        try {
          if (result.error !== null) throw result.error
          if (result.cached && result.observation) {
            const observation = result.observation
            this.store.commit(null, current => {
              const card = current.cards.find(row => row.sessionId === result.sessionId)
              return card ? applyObservation(card, observation, this.now(), this.eligibleSource(card, result.source ?? undefined), current) : false
            }, undefined, result.source ? [result.source] : [])
            this.dirty.delete(result.sessionId)
            this.syncErrors.delete(result.sessionId)
            this.store.saveColdCheckpoint({ ...result.cached, observation, updatedAt: this.now() })
            continue
          }
          const capture = result.capture
          if (!capture || !capture.validate()) fail('REVIEW_STALE', '运行来源变化，正在重新同步')
          this.store.commit(null, current => {
            const card = current.cards.find(row => row.sessionId === result.sessionId)
            return card ? applyObservation(card, capture.observation, this.now(), this.eligibleSource(card, result.source), current) : false
          }, () => { if (!capture.validate()) fail('REVIEW_STALE', '运行来源已变化，请重新同步') }, result.source ? [result.source] : [])
          if (result.probe && !result.probe.live && result.probe.headerDigest !== undefined && result.probe.revision !== undefined)
            this.store.saveColdCheckpoint({ sessionId: result.sessionId, headerDigest: result.probe.headerDigest,
              inherited: result.probe.inherited ?? null, revision: result.probe.revision, sizeBytes: result.probe.sizeBytes ?? null,
              observation: capture.observation, updatedAt: this.now() })
          this.dirty.delete(result.sessionId)
          this.syncErrors.delete(result.sessionId)
        } catch (error) {
          this.syncErrors.set(result.sessionId, errorText(error).slice(0, 1000))
          this.dirty.add(result.sessionId)
          try {
            this.store.commit(null, current => {
              const card = current.cards.find(row => row.sessionId === result.sessionId)
              if (!card) return false
              return applyObservation(card, { runtime: unknownRuntime(errorText(error).slice(0, 1000)), title: card.hostTitle, workspace: card.workspace, activityAt: card.activityAt, hostArchive: unknownHostArchive() }, this.now())
            }, undefined, [unavailableReplay(result.sessionId, errorText(error))])
          } catch (storageError) { this.report(storageError) }
        } finally { result.capture?.dispose() }
      }
    }
    this.lastReconcileAt = this.now()
    const current = this.store.read()
    this.updateHealth(current)
    if (this.health.state === 'ready') this.health.lastSyncAt = this.now()
  }
  snapshot(fence: Fence = () => {}): Promise<Snapshot> {
    return this.enqueue(async () => {
      fence()
      await this.reconcile(this.lastReconcileAt === 0 || this.now() - this.lastReconcileAt > 15000)
      fence()
      return this.snapshotValue()
    })
  }
  /** Retain ephemeral sync-error withdrawals on the exact cut returned to
   * extensions; reading the store again after snapshot() would lose them. */
  extensionSnapshot(fence: Fence = () => {}): Promise<StoreSnapshot> {
    return this.enqueue(async () => {
      fence()
      await this.reconcile(this.lastReconcileAt === 0 || this.now() - this.lastReconcileAt > 15000)
      fence()
      return this.effectiveStoreSnapshot()
    })
  }
  async candidates(raw: CandidateQuery, fence: Fence = () => {}): Promise<CandidatePage> {
    const parsed = candidateQuerySchema.parse(raw)
    // Product defaults apply at the public boundary, never by hiding rows after a page.
    const query = { ...parsed, membership: parsed.membership ?? 'untracked', hostArchive: parsed.hostArchive ?? 'active' }
    return this.enqueue(async () => {
      fence()
      const board = this.store.read()
      const members = new Set(board.cards.map(card => card.sessionId))
      const cards = new Map(board.cards.map(card => [card.sessionId, card]))
      const membership = digestCommand(board.cards.map(card => [card.sessionId, card.membershipId]).sort())
      const page = await this.host.list({ ...query, generation: null }, members)
      fence()
      if (typeof page.generation !== 'string' || !page.generation.length) fail('UNAVAILABLE', '宿主候选缺少可靠来源代次，不能安全分页或判断成员资格')
      if (new Set(page.items.map(item => item.sessionId)).size !== page.items.length) fail('UNAVAILABLE', '宿主候选返回重复身份，不能提供可靠总数与分页')
      const generation = digestCommand({ membership, host: page.generation, search: query.search, membershipFilter: query.membership, archive: query.hostArchive })
      if (query.generation && query.generation !== generation || query.offset > 0 && !query.generation) fail('CONFLICT', '候选成员、宿主归档或查询范围已变化，请重新加载第一页')
      // A list row is an index, not an inspection: untracked candidates carry no runtime
      // facts (null), and only inspectSession may open a source and report one. Tracked
      // rows keep the runtime already stored for that member.
      const items: CandidatePage['items'] = page.items.map(item => {
        const tracked = cards.get(item.sessionId) ?? null
        return tracked
          ? { ...item, hostArchive: item.hostArchive ?? unknownHostArchive(), tracked, runtime: tracked.runtime }
          : { ...item, tracked: null, runtime: null, hostArchive: item.hostArchive ?? unknownHostArchive() }
      })
      fence()
      // The listing above is asynchronous and may cross an archive, title, visibility,
      // source-provider or corpus change. Revalidate the entire cut, not just returned
      // rows: filtering or hiding one row here would keep an untrue total/offset.
      const current = await this.host.list({ ...query, offset: 0, limit: 1, generation: page.generation }, members)
      fence()
      if (current.generation !== page.generation || current.total !== page.total) fail('CONFLICT', '宿主候选来源在读取期间变化，请重新加载第一页')
      if (digestCommand(this.store.read().cards.map(card => [card.sessionId, card.membershipId]).sort()) !== membership) fail('CONFLICT', '成员集合已变化，请重新查询候选')
      if (items.some(item => query.membership !== 'all' && (item.tracked !== null) !== (query.membership === 'tracked')
        || query.hostArchive !== 'all' && item.hostArchive.state !== query.hostArchive)) fail('CONFLICT', '候选成员或宿主归档事实已变化，旧总数与分页不可继续使用')
      return { ...page, items, generation }
    })
  }
  transcript(raw: TranscriptQuery, fence: Fence = () => {}): Promise<Transcript> {
    const query = transcriptQuerySchema.parse(raw)
    return this.enqueue(async () => {
      fence()
      const card = this.store.read().cards.find(row => row.sessionId === query.sessionId) ?? fail('NOT_FOUND', '会话已移出看板，请刷新')
      const result = await this.host.transcript(query.sessionId).catch(error => fail('UNAVAILABLE', `无法读取会话内容：${errorText(error)}`))
      fence()
      return { sessionId: query.sessionId, title: card.titleOverride || card.hostTitle || query.sessionId, messages: result.messages, truncated: result.truncated, coverage: result.truncated ? 'partial' as const : 'complete' as const, reason: null }
    })
  }
  navigation(raw: NavigationQuery, fence: Fence): Promise<NavigationResult> {
    const query = navigationQuerySchema.parse(raw)
    return this.enqueue(async () => {
      fence()
      const capture = await this.observe(query.sessionId)
      try {
        fence()
        if (!capture.validate()) fail('REVIEW_STALE', '运行请求已变化，请重试同步后操作')
        const existing = this.store.read().cards.find(card => card.sessionId === query.sessionId)
        if (existing) this.store.commit(null, board => applyObservation(cardFor(board, query.sessionId), capture.observation, this.now(), this.eligibleSource(cardFor(board, query.sessionId), capture.source), board), () => { fence(); if (!capture.validate()) fail('REVIEW_STALE', '运行请求已变化') }, capture.source ? [capture.source] : [])
        const current = this.store.read().cards.find(card => card.sessionId === query.sessionId)
        if (query.expectedLifecycleRevision !== undefined && current?.lifecycleRevision !== query.expectedLifecycleRevision
          || query.runtimeFingerprint !== undefined && capture.observation.runtime.fingerprint !== query.runtimeFingerprint) fail('REVIEW_STALE', '旧行动入口已失效，请同步当前原因与下一步')
        const archive = capture.observation.hostArchive
        const reason = archive.state === 'archived' ? 'DSH 会话已归档；请在宿主原生会话列表选择显示归档，显式取消归档后再查看。恢复不会自动续跑。'
          : archive.state !== 'active' ? archive.reason ?? '宿主归档事实不可用，不能确认可进入；请从原生会话列表处理。'
          : capture.observation.runtime.sync === 'missing' ? '会话不存在或不可访问' : null
        fence()
        return { sessionId: query.sessionId, allowed: reason === null, reason, hostArchive: archive }
      } finally { capture.dispose() }
    })
  }
  async mutate(raw: Mutation, fence: Fence = () => {}): Promise<Snapshot> {
    if (raw.apiVersion !== 2) fail('UNSUPPORTED_API', 'Unsupported dashboard API; expected version 2')
    const mutation = mutationSchema.parse(raw)
    const authority = () => { fence(); if (mutation.serviceId !== this.serviceId || this.closed) fail('UNAVAILABLE', 'Dashboard service changed; inspect the current instance before retrying') }
    authority()
    return this.enqueue(async () => {
      authority()
      const command = mutation.command
      const receipt = { requestId: mutation.requestId, digest: digestCommand(command) }
      const previousFence = fence
      fence = () => { previousFence(); if (mutation.serviceId !== this.serviceId || this.closed) fail('UNAVAILABLE', 'Dashboard service instance is no longer current') }
      // A transport retry of a committed operation needs no new host authority and
      // must not fail after its session disappeared. It returns current state, never replays.
      if (command.type !== 'resync' && this.store.wasCommitted(receipt)) {
        fence(); return this.snapshotValue()
      }
      if (command.type === 'resync') {
        if (command.sessionId) this.dirty.add(command.sessionId)
        const release = command.sessionId && await this.useBaseline(command.sessionId) ? await this.baseline.hold(command.sessionId) : () => {}
        try { await this.reconcile(command.sessionId === null) } finally { release() }
        fence(); return this.snapshotValue()
      }
      let capture: HostCapture | null = null
      const bounded = 'sessionId' in command ? await this.useBaseline(command.sessionId) : false
      const releaseHold = bounded && 'sessionId' in command ? await this.baseline.hold(command.sessionId) : () => {}
      try {
        const existing = 'sessionId' in command ? this.store.read().cards.find(card => card.sessionId === command.sessionId) : undefined
        if (command.type === 'review' || command.type === 'rebaseline_source' || command.type === 'choose_state' || command.type === 'archive' || command.type === 'move_project' || command.type === 'add_card') {
          try { capture = await this.observe(command.sessionId, !bounded) }
          catch (error) {
            if (existing) {
              this.syncErrors.set(existing.sessionId, errorText(error).slice(0, 1000))
              this.dirty.add(existing.sessionId)
              this.store.commit(null, board => {
                const card = cardFor(board, existing.sessionId)
                return applyObservation(card, { runtime: unknownRuntime(errorText(error).slice(0, 1000)), title: card.hostTitle, workspace: card.workspace, activityAt: card.activityAt, hostArchive: unknownHostArchive() }, this.now())
              }, fence, [unavailableReplay(existing.sessionId, errorText(error))])
              this.updateHealth(this.store.read())
            }
            if (command.type !== 'archive') throw error
            // Visibility can be managed while the host is unavailable; it cannot confer review authority.
          }
        }
        fence()
        if (capture && !capture.validate()) fail('REVIEW_STALE', '会话运行发生变化，请同步后重新核对')
        if (capture && bounded) {
          const needsSource = command.type === 'review' || command.type === 'rebaseline_source' || command.type === 'choose_state'
            || command.type === 'move_project' && command.destination.kind !== 'preserve'
          if (needsSource) {
            capture = await this.requireSource(capture, command.sessionId, '执行此操作')
            if (!capture.validate()) fail('REVIEW_STALE', '来源基线建立后会话已变化，请重试')
          } else if (command.type !== 'add_card' && command.type !== 'archive' && 'sessionId' in command) {
            capture = await this.attachSource(capture, command.sessionId)
          }
        }
        // An add always stays available: the binding remains source-free and the
        // baseline is attached only when it already exists at this exact cut.
        const addSource = bounded && command.type === 'add_card' && capture
          ? this.baseline.peek(command.sessionId, capture.observation.runtime.cursor) ?? undefined : undefined
        if (bounded && command.type === 'add_card' && !addSource) this.baseline.ensure(command.sessionId)
        const rebaselineSource = Boolean(existing && command.type === 'rebaseline_source' && capture?.source
          && capture.source.coverage === 'complete')
        // Persist independent host facts FIRST so a rejected stale human request still refreshes progress.
        if (capture && existing) {
          const observed = capture
          this.store.commit(null, board => applyObservation(cardFor(board, existing.sessionId), observed.observation, this.now(), this.eligibleSource(cardFor(board, existing.sessionId), observed.source), board), () => { fence(); if (!observed.validate()) fail('REVIEW_STALE', '当前轮次已变化') }, observed.source ? [observed.source] : [])
          this.syncErrors.delete(existing.sessionId)
        }
        const activeCapture = capture
        this.store.commit(receipt, board => {
          if (command.type === 'add_card') {
            if (!activeCapture) fail('UNAVAILABLE', 'Session inspection source is unavailable')
            const binding = this.inspectionBinding(board, command.sessionId, activeCapture), expected = command.inspection
            if (expected.serviceId !== this.serviceId || expected.membershipId !== binding.membershipId
              || expected.membershipId === null && expected.boardRevision !== binding.boardRevision
              || expected.membershipId !== null && (expected.metadataRevision !== binding.metadataRevision || expected.lifecycleRevision !== binding.lifecycleRevision || expected.workflowRevision !== binding.workflowRevision || expected.sourceIdentity !== binding.sourceIdentity || expected.sourceCursor !== binding.sourceCursor)
              || expected.runtimeFingerprint !== binding.runtimeFingerprint || expected.hostArchiveGeneration !== binding.hostArchiveGeneration) fail('CONFLICT', 'Session inspection is stale; inspect the current session before joining')
          }
          const member = 'sessionId' in command ? board.cards.find(card => card.sessionId === command.sessionId) : undefined
          const source = command.type === 'add_card' ? addSource
            : member ? (rebaselineSource ? activeCapture?.source : this.eligibleSource(member, activeCapture?.source)) : activeCapture?.source
          return this.applyCommand(board, command, activeCapture?.observation ?? null, source)
        }, () => {
          fence()
          if (activeCapture && !activeCapture.validate()) fail('REVIEW_STALE', '执行信息已变化，未提交旧确认')
        }, addSource ? [addSource] : activeCapture?.source ? [activeCapture.source] : [], rebaselineSource && existing ? new Set([existing.membershipId]) : undefined)
        if ('sessionId' in command) this.dirty.add(command.sessionId)
        return this.snapshotValue()
      } finally { capture?.dispose(); releaseHold() }
    })
  }
  private applyCommand(board: Board, command: Exclude<Command, { type: 'resync' }>, observation: HostObservation | null, source?: SourceReplay): boolean {
    const now = this.now()
    if ('membershipId' in command) assertMembership(cardFor(board, command.sessionId), command.membershipId)
    switch (command.type) {
      case 'create_project': {
        assertName([...board.projects, ...board.tags], command.name); validateTags(board, command.tagIds)
        const project: Project = { id: randomUUID(), name: command.name, color: command.color, createdAt: now, revision: 0, tagIds: [...command.tagIds] }
        board.projects.push(project); appendOrder(board, 'project', project.id); return true
      }
      case 'update_project': {
        const project = projectFor(board, command.projectId, command.expectedProjectRevision)
        assertName([...board.projects, ...board.tags], command.name, project.id); validateTags(board, command.tagIds)
        if (project.name === command.name && project.color === command.color && same(project.tagIds, command.tagIds)) return false
        project.name = command.name; project.color = command.color; project.tagIds = [...command.tagIds]; project.revision += 1
        this.revokeProjectWitnesses(board, project.id); return true
      }
      case 'delete_project': {
        const project = projectFor(board, command.projectId, command.expectedProjectRevision)
        // The project is a grouping concept: deleting it removes its states and membership,
        // never the sessions, host chats or history of the sessions it grouped.
        board.projects = board.projects.filter(row => row.id !== project.id)
        const order = board.orders.project
        order.ids = order.ids.filter(id => id !== project.id); order.revision += 1
        for (const card of board.cards) {
          if (card.projectId !== project.id) continue
          card.projectId = null; card.metadataRevision += 1; card.updatedAt = now
        }
        return true
      }
      case 'choose_state': {
        const card = cardFor(board, command.sessionId); assertEditable(card); assertStateWorkflow(card, command)
        this.assertStateChoice(card, source)
        this.selectState(board, card, command.selection, source); card.updatedAt = now; return true
      }
      case 'create_label': {
        const label = { id: randomUUID(), name: command.name, color: command.color, createdAt: now, revision: 0 }
        if (command.dimension === 'status') {
          assertStateName(board.statuses, command.name)
          board.statuses.push(label)
        } else if (command.dimension === 'tag') {
          assertName([...board.tags, ...board.projects], command.name)
          const groupId = command.groupId ?? null
          if (groupId !== null && !board.tagGroups.some(group => group.id === groupId)) fail('NOT_FOUND', '标签组不存在')
          board.tags.push({ ...label, groupId })
        } else fail('INVALID', '只能新建状态或标签')
        appendOrder(board, command.dimension, label.id); return true
      }
      case 'update_label': {
        if (command.dimension === 'status') {
          if (reservedStates.has(command.id) && ['in_progress', 'pending_confirm', 'pending_review', 'accepted'].includes(command.id)) fail('FORBIDDEN', '内置状态不能改名或改色')
          const label = board.statuses.find(row => row.id === command.id) ?? fail('NOT_FOUND', '状态不存在')
          if (label.revision !== command.expectedRevision) fail('CONFLICT', '状态已被其他窗口修改，请刷新')
          assertStateName(board.statuses, command.name, label.id)
          if (label.name === command.name && label.color === command.color) return false
          label.name = command.name; label.color = command.color; label.revision += 1; return true
        }
        const label = board.tags.find(row => row.id === command.id) ?? fail('NOT_FOUND', '标签已不存在')
        if (label.revision !== command.expectedRevision) fail('CONFLICT', '标签已被其他窗口修改，请刷新')
        const current = label.groupId === null ? null : board.tagGroups.find(group => group.id === label.groupId) ?? null
        // A builtin group owns its values: they may be extended, never edited.
        if (current?.builtin) fail('FORBIDDEN', '系统定义的标签值不能修改，只能扩充')
        const groupId = command.groupId === undefined ? label.groupId : command.groupId
        if (groupId !== null && groupId !== label.groupId) {
          const target = board.tagGroups.find(group => group.id === groupId) ?? fail('NOT_FOUND', '标签组不存在')
          if (target.builtin) fail('FORBIDDEN', '系统标签组只接受新增值，不能移入已有标签')
        }
        assertName(board.tags, command.name, label.id)
        if (label.name === command.name && label.color === command.color && label.groupId === groupId) return false
        label.name = command.name; label.color = command.color; label.groupId = groupId; label.revision += 1; return true
      }
      case 'delete_label': {
        if (command.dimension === 'status') {
          if (['in_progress', 'pending_confirm', 'pending_review', 'accepted'].includes(command.id)) fail('FORBIDDEN', '内置状态不能删除')
          const label = board.statuses.find(row => row.id === command.id) ?? fail('NOT_FOUND', '状态不存在')
          if (label.revision !== command.expectedRevision) fail('CONFLICT', '状态已被其他窗口修改，请刷新')
          // Deleting a status unplaces every card that sat in it, exactly like the
          // retired per-project delete_state did.
          for (const card of board.cards) {
            if (card.placement.kind === 'custom' && card.placement.statusId === label.id) { card.placement = { kind: 'unset' }; card.workflowRevision += 1; card.updatedAt = now }
            if (card.placementWitness?.state?.statusId === label.id) { card.placementWitness = { ...card.placementWitness, state: null }; card.workflowRevision += 1 }
          }
          board.statuses = board.statuses.filter(row => row.id !== label.id)
          board.orders.status.ids = board.orders.status.ids.filter(id => id !== label.id)
          board.orders.status.revision += 1; return true
        }
        const label = board.tags.find(row => row.id === command.id) ?? fail('NOT_FOUND', '标签已不存在')
        if (label.revision !== command.expectedRevision) fail('CONFLICT', '标签已被其他窗口修改，请刷新')
        if (label.groupId !== null && board.tagGroups.find(group => group.id === label.groupId)?.builtin) fail('FORBIDDEN', '系统定义的标签值不能删除')
        if (board.cards.some(card => card.tagIds.includes(label.id)) || board.projects.some(project => project.tagIds.includes(label.id))) fail('IN_USE', '该标签仍被会话或项目使用；请先移除引用')
        board.tags = board.tags.filter(row => row.id !== label.id)
        board.orders.tag.ids = board.orders.tag.ids.filter(id => id !== label.id)
        board.orders.tag.revision += 1; return true
      }
      case 'create_tag_group': {
        assertName(board.tagGroups, command.name)
        const groupId = randomUUID()
        board.tagGroups.push({ id: groupId, name: command.name, color: command.color, builtin: false, revision: 0 })
        appendOrder(board, 'tagGroup', groupId)
        return true
      }
      case 'update_tag_group': {
        const group = board.tagGroups.find(row => row.id === command.groupId) ?? fail('NOT_FOUND', '标签组不存在')
        if (group.builtin) fail('FORBIDDEN', '系统定义的标签组不能修改')
        if (group.revision !== command.expectedRevision) fail('CONFLICT', '标签组已被其他窗口修改，请刷新')
        assertName(board.tagGroups, command.name, group.id)
        if (group.name === command.name && group.color === command.color) return false
        group.name = command.name; group.color = command.color; group.revision += 1; return true
      }
      case 'delete_tag_group': {
        const group = board.tagGroups.find(row => row.id === command.groupId) ?? fail('NOT_FOUND', '标签组不存在')
        if (group.builtin) fail('FORBIDDEN', '系统定义的标签组不能删除')
        if (group.revision !== command.expectedRevision) fail('CONFLICT', '标签组已被其他窗口修改，请刷新')
        if (board.tags.some(tag => tag.groupId === group.id)) fail('IN_USE', '标签组里还有标签；请先清空')
        board.tagGroups = board.tagGroups.filter(row => row.id !== group.id)
        board.orders.tagGroup.ids = board.orders.tagGroup.ids.filter(id => id !== group.id)
        board.orders.tagGroup.revision += 1
        return true
      }
      case 'reorder': {
        const order = board.orders[command.dimension]
        if (order.revision !== command.expectedRevision) fail('CONFLICT', '排列或选项已经变化，请刷新后重新排列')
        const unique = new Set(command.ids)
        if (unique.size !== command.ids.length) fail('INVALID', '排列必须恰好包含该维度的全部选项')
        if (command.dimension === 'status') {
          // Built-in statuses and custom statuses share one order; every id appears once.
          const expected = new Set(['in_progress', 'pending_confirm', 'pending_review', 'accepted', ...board.statuses.map(status => status.id)])
          if (command.ids.length !== expected.size || command.ids.some(id => !expected.has(id))) fail('INVALID', '状态顺序必须包含全部内置状态与自定义状态各一次')
        } else if (command.ids.length !== order.ids.length || command.ids.some(id => !order.ids.includes(id))) fail('INVALID', '排列必须恰好包含该维度的全部选项')
        // The unassigned sentinel is a virtual bucket, not a tag: it always sorts
        // last, so a reorder only decides the order of the real values.
        const next = command.dimension === 'project' ? [...command.ids.filter(id => id !== EMPTY), EMPTY] : [...command.ids]
        if (same(order.ids, next)) return false
        order.ids = next; order.revision += 1; return true
      }
      case 'add_card': {
        if (board.cards.some(card => card.sessionId === command.sessionId)) return false
        assertClassification(board, command.projectId)
        if (!observation || observation.runtime.sync === 'missing') fail('NOT_FOUND', '此宿主会话不存在或不可访问')
        const card = initialCard(command.sessionId, command.projectId, observation, now)
        if (card.runtime.episodeId) card.origin = { kind: 'unspecified', episodeId: card.runtime.episodeId, episodeOrder: card.runtime.episodeOrder, reason: 'before_membership' }
        if (card.runtime.sync === 'synced' && card.runtime.sourceLive && card.runtime.phase === 'not_started' && card.runtime.episodeId === null) card.placement = { kind: 'unset' }
        // Seed from the monotonically increasing aggregate revision, not zero:
        // remove→re-add must not reuse a stale editor/review CAS token (ABA).
        card.metadataRevision = board.revision + 1
        card.lifecycleRevision = board.revision + 1
        card.workflowRevision = board.revision + 1
        card.placementWitness = makeWitness(card, source, null)
        board.cards.push(card); return true
      }
      case 'edit_card': {
        const card = cardFor(board, command.sessionId); assertEditable(card); assertMetadata(card, command.expectedMetadataRevision)
        assertClassification(board, card.projectId)
        if (new Set(command.tagIds).size !== command.tagIds.length || command.tagIds.some(id => !board.tags.some(label => label.id === id))) fail('INVALID', '普通标签有重复或已不存在')
        card.tagIds = [...command.tagIds]
        card.titleOverride = command.titleOverride || null; card.progress = command.progress
        card.metadataRevision += 1; card.updatedAt = now; return true
      }
      case 'move_project': {
        if (!observation || observation.runtime.sync !== 'synced') fail('UNAVAILABLE', '无法可靠读取移动来源；未修改项目或恢复卡片')
        const card = cardFor(board, command.sessionId); assertEditable(card); assertWorkflow(card, command)
        assertClassification(board, command.projectId)
        if (command.projectId !== null) projectFor(board, command.projectId, command.expectedTargetProjectRevision ?? fail('CONFLICT', 'Target project revision required'))
        else if (command.expectedTargetProjectRevision !== null) fail('INVALID', 'No project cannot have a project revision')
        const process = card.placement.kind === 'builtin' && (card.runtime.episodeId !== null || card.runtime.phase !== 'not_started')
        if (process && command.destination.kind !== 'preserve' || !process && command.destination.kind === 'preserve') fail('INVALID', 'Choose an explicit project destination outside the built-in process; preserve is required within it')
        if (card.projectId === command.projectId && command.destination.kind === 'preserve') return false
        card.projectId = command.projectId; card.metadataRevision += 1
        if (command.destination.kind === 'preserve') { card.workflowRevision += 1; card.placementWitness = null }
        else { this.assertStateChoice(card, source); this.selectState(board, card, command.destination, source) }
        card.updatedAt = now; return true
      }
      case 'rebaseline_source': {
        const card = cardFor(board, command.sessionId); assertMembership(card, command.membershipId); assertMetadata(card, command.expectedMetadataRevision)
        if (!source || !sourceCut(source, source.throughCursor)) fail('UNAVAILABLE', 'A complete source is required to establish a new baseline')
        return false
      }
      case 'confirm_review': {
        const card = cardFor(board, command.sessionId); assertEditable(card); assertWorkflow(card, command)
        // Idempotent: a card already waiting for review needs no further step.
        if (card.status === 'pending_review') return false
        if (card.status !== 'pending_confirm' || card.placement.kind !== 'builtin' || card.placement.status !== 'pending_confirm') fail('INVALID', '只有待确认的会话可以确认')
        if (card.runtime.sync !== 'synced' || card.runtime.phase !== 'completed' || !card.runtime.episodeId) fail('REVIEW_STALE', '当前轮次尚未完整结束，不能确认')
        card.status = 'pending_review'; card.placement = { kind: 'builtin', status: 'pending_review' }
        card.lifecycleRevision += 1; card.workflowRevision += 1; card.updatedAt = now
        return true
      }
      case 'review': {
        const card = cardFor(board, command.sessionId); assertEditable(card)
        assertWorkflow(card, command)
        if (card.placement.kind !== 'builtin') fail('INVALID', 'Custom placement is not a pending or accepted built-in review')
        if (card.placement.status !== card.status) fail('REVIEW_STALE', '内置位置与当前处置不一致，请同步后重新核对')
        if (card.runtime.sync !== 'synced' || !card.runtime.sourceLive || !sourceCut(source, card.runtime.cursor)) fail('REVIEW_STALE', 'A live complete eligible execution source is required')
        if (command.action !== 'accept' && command.destination.kind !== 'stay') fail('INVALID', 'Only acceptance may select a destination')
        if (!command.confirmed) fail('INVALID', 'Explicit confirmation is required for a review decision')
        if (command.action === 'accept') {
          if (!command.confirmed) fail('INVALID', '验收需要用户明确确认已核对本轮结果')
          // Choosing the destination is the human look that confirmation would
          // otherwise record. Accept directly from 待确认 in one commit so a
          // failed review can never leave a half-applied status change behind.
          if ((card.status !== 'pending_review' && card.status !== 'pending_confirm') || card.runtime.sync !== 'synced' || !card.runtime.sourceLive || card.runtime.phase !== 'completed' || !card.runtime.episodeId) fail('REVIEW_STALE', '当前不能验收；请进入会话并同步最新执行信息')
          card.status = 'accepted'; card.acceptedAt = now; card.reviewAt = null
          card.decision = { kind: 'accepted', episodeId: card.runtime.episodeId, at: now }
        } else {
          if (command.action === 'return' && card.status !== 'pending_review' || command.action === 'reopen' && card.status !== 'accepted') fail('INVALID', '此状态不能执行该动作')
          card.status = 'in_progress'; card.acceptedAt = null; card.reviewAt = null
          card.decision = { kind: command.action === 'return' ? 'returned' : 'reopened', episodeId: card.runtime.episodeId, at: now }
        }
        if (command.action === 'accept' && command.destination.kind === 'custom' && !sourceCut(source, card.runtime.cursor)) fail('UNAVAILABLE', 'A complete source is required to select a review destination')
        card.placement = { kind: 'builtin', status: card.status }
        card.lifecycleRevision += 1; card.workflowRevision += 1
        if (command.action === 'accept' && command.destination.kind === 'custom') this.selectState(board, card, command.destination, source)
        else card.placementWitness = makeWitness(card, source, card.origin?.kind === 'state' ? card.origin.state : null)
        card.updatedAt = now; return true
      }
      case 'archive': {
        const card = cardFor(board, command.sessionId); assertMetadata(card, command.expectedMetadataRevision)
        if (command.archived && (card.runtime.sync !== 'synced' || ['running', 'waiting_input', 'waiting_approval', 'continuation_pending', 'suspended'].includes(card.runtime.phase)) && !command.confirmedRunning) fail('INVALID', '归档不会停止运行；请确认后继续')
        if ((card.archivedAt !== null) === command.archived) return false
        card.archivedAt = command.archived ? now : null; card.metadataRevision += 1; card.updatedAt = now; return true
      }
      case 'remove_card': {
        const card = cardFor(board, command.sessionId); assertMetadata(card, command.expectedMetadataRevision)
        board.cards = board.cards.filter(row => row.sessionId !== card.sessionId)
        return true
      }
      case 'preferences': {
        if (board.preferences.revision !== command.expectedRevision) fail('CONFLICT', '视图偏好已在其他窗口修改，请刷新后重试')
        board.preferences = { ...command.value, revision: board.preferences.revision + 1 }; return true
      }
    }
  }
  private eligibleSource(card: Card, source: SourceReplay | undefined): SourceReplay | undefined {
    if (!source || this.store.sourceEligible(card.membershipId, source)) return source
    return { ...source, coverage: 'unavailable', reason: 'Member source prefix changed; remove and re-add to establish an explicit new baseline' }
  }
  private revokeProjectWitnesses(board: Board, projectId: string): void {
    for (const card of board.cards) if (card.projectId === projectId) {
      card.placementWitness = null; card.workflowRevision += 1
    }
  }
  private assertStateChoice(card: Card, source: SourceReplay | undefined): void {
    if (card.runtime.sync !== 'synced' || !card.runtime.sourceLive || !sourceCut(source, card.runtime.cursor)) fail('UNAVAILABLE', 'A fresh complete live source is required for state selection')
    const neverExecuted = card.runtime.episodeId === null && card.runtime.phase === 'not_started'
    const accepted = card.status === 'accepted' && card.runtime.phase === 'completed' && card.decision?.kind === 'accepted'
    const historical = card.status === 'accepted' && card.decision?.kind === 'historical' && neverExecuted
    if (!neverExecuted && !accepted && !historical) fail('INVALID', 'Resolve the built-in execution process before choosing a state')
  }
  private selectState(board: Board, card: Card, selection: StateSelection, source: SourceReplay | undefined): void {
    const snapshot = selection.kind === 'custom' ? targetStatus(board, selection.target) : null
    card.placement = snapshot ? { kind: 'custom', statusId: snapshot.statusId } : { kind: 'unset' }
    card.workflowRevision += 1
    card.placementWitness = makeWitness(card, source, snapshot)
    if (!card.placementWitness) fail('UNAVAILABLE', 'Unable to establish a reliable state source cut')
  }
  private inspectionBinding(board: Board, sessionId: string, capture: HostCapture): SessionInspectionBinding {
    const card = board.cards.find(row => row.sessionId === sessionId)
    const source = capture.source
    return { serviceId: this.serviceId, boardRevision: board.revision, membershipId: card?.membershipId ?? null,
      metadataRevision: card?.metadataRevision ?? null, lifecycleRevision: card?.lifecycleRevision ?? null, workflowRevision: card?.workflowRevision ?? null,
      runtimeFingerprint: capture.observation.runtime.fingerprint, sourceIdentity: source?.coverage === 'complete' ? source.sourceIdentity : null,
      sourceCursor: source?.coverage === 'complete' ? source.throughCursor : null,
      // A new membership has no prior source baseline, so the add binding never
      // depends on whether a background baseline already exists.
      hostArchiveGeneration: digestCommand({ archive: capture.observation.hostArchive, version: card ? source?.archiveVersion ?? null : null }) }
  }
  inspectSession(raw: InspectionQuery, fence: Fence = () => {}): Promise<SessionInspection> {
    const query = inspectionQuerySchema.parse(raw)
    return this.enqueue(async () => {
      const bounded = await this.useBaseline(query.sessionId)
      let capture = await this.observe(query.sessionId, !bounded)
      try {
        if (bounded) capture = await this.attachSource(capture, query.sessionId)
        fence(); if (!capture.validate()) fail('REVIEW_STALE', 'Session changed during inspection')
        if (capture.observation.runtime.sync === 'missing') fail('NOT_FOUND', 'Session does not exist or is not accessible')
        this.store.commit(null, board => { const card = board.cards.find(row => row.sessionId === query.sessionId); return card ? applyObservation(card, capture.observation, this.now(), this.eligibleSource(card, capture.source), board) : false }, () => { fence(); if (!capture.validate()) fail('REVIEW_STALE', 'Session changed during inspection') }, capture.source ? [capture.source] : [])
        const snapshot = this.snapshotValue(), tracked = snapshot.board.cards.find(card => card.sessionId === query.sessionId) ?? null
        const observation = capture.observation
        fence(); if (!capture.validate()) fail('REVIEW_STALE', 'Session changed during inspection')
        return { snapshot, candidate: { sessionId: query.sessionId, title: observation.title, workspace: observation.workspace, activityAt: observation.activityAt, hostArchive: observation.hostArchive, runtime: observation.runtime, tracked }, binding: this.inspectionBinding(snapshot.board, query.sessionId, capture) }
      } finally { capture.dispose() }
    })
  }
  history(raw: HistoryQuery, fence: Fence = () => {}): Promise<HistoryPage> {
    const query = historyQuerySchema.parse(raw)
    return this.enqueue(() => { fence(); const page = this.store.history(query); fence(); return page })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer); this.unsubscribe(); this.baseline.close()
    await this.chain
    this.host.close(); this.store.close()
  }
}
