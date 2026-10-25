import { createHash } from 'node:crypto'
import { applyGoalProjection, goalProjectionDefinition, type GoalProjectionState } from '@deepseek-ai/dsh-goal'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { installedHostCapabilities, isTimedQuestionSchema } from './compat.js'
import type { RuntimeFact, TurnEnd, TurnEndCause } from '../shared/model.js'

/** These are journal facts, not a second Agent state machine. Only actual turn boundaries
 * settle a run; steps, messages, tools and process-local idle never do. */
export interface Episode { id: string; order: number; startedAt: number; goalId: string | null; abandoned: boolean }
export interface TurnEndError { code: string; status?: number }
export interface Turn { number: number; seq: number; time: number; human: boolean; owned: boolean; work: boolean; stepped: boolean; end: { kind: string; cause: string | null; error: TurnEndError | null; seq: number; time: number } | null }
export interface LifecycleJournalState {
  version: 1
  headerId: string
  inheritedEventCount: number
  cursor: number
  title: string
  activityAt: number | null
  episode: Episode | null
  turn: Turn | null
  lastWorkTurn: Turn | null
  goalState: GoalProjectionState
  goalCompletion: { id: string; time: number } | null
  timedSchema: boolean
  sawTimedQuestion: boolean
  legacyQuestions: string[]
  approvals: string[]
}
/** The immutable identity of a source log. `delegationDepth` is normalized to a
 *  fixed position: DSH may materialize the default field at different times or
 *  in a different property order, and JSON digesting must not turn that into a
 *  false prefix change. Returns canonical identity plus safe compatibility
 *  variants for baselines written from the raw/no-depth header shape. */
export function canonicalSourceHeader(header: SessionHeader): SessionHeader & { delegationDepth: number } {
  const { delegationDepth, ...rest } = header
  return { ...rest, delegationDepth: delegationDepth ?? 0 }
}
export function sourceIdentityVariants(header: SessionHeader, inherited: number): { identity: string; legacy: string[] } {
  const canonical = digest({ header: canonicalSourceHeader(header), inherited })
  // Early builds omitted a zero delegationDepth entirely. Keep only that exact
  // historical shape as a compatibility identity; arbitrary header field order
  // is never a reason to bypass the prefix-chain check.
  const withoutDepth = { ...header }
  if ((withoutDepth.delegationDepth ?? 0) === 0) delete withoutDepth.delegationDepth
  const noDepth = digest({ header: withoutDepth, inherited })
  return { identity: canonical, legacy: noDepth === canonical ? [] : [noDepth] }
}
export function sourceHeaderDigest(header: SessionHeader, inherited: number): string {
  return digest({ id: header.id, header: canonicalSourceHeader(header), inherited })
}
export interface LiveGoal { id: string; revision: number; phase: 'active' | 'paused' | 'blocked' | 'complete'; roundsStarted: number; maxGoalRounds: number; activation: 'armed' | 'disarmed' }
export interface QuestionFact { callId: string; state: 'open' | 'continued' }
export interface LifecycleEnvironment {
  sourceLive: boolean
  status: 'idle' | 'running' | null
  goal: LiveGoal | null
  goalAvailable: boolean
  questions: readonly QuestionFact[] | null
  inputWaits: number
  approvalWaits: number
  pendingInput: number
  /** Live agents under this session (the main agent included). */
  activeAgents: number
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('Expected a structured host record')
  return value
}
export function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid host ${name}`)
  return value
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Invalid host ${name}`)
  return value
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function readLiveGoal(value: unknown): LiveGoal | null {
  if (value === undefined) return null
  const row = object(value)
  const phase = row.phase
  const activation = row.activation
  if (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete') throw new Error('Invalid live goal phase')
  if (activation !== 'armed' && activation !== 'disarmed') throw new Error('Invalid live goal activation')
  return { id: text(row.id, 'goal identity'), revision: integer(row.revision, 'goal revision', 1), phase,
    roundsStarted: integer(row.roundsStarted, 'goal rounds'), maxGoalRounds: integer(row.maxGoalRounds, 'goal round cap', 1), activation }
}
export function readQuestions(value: unknown): readonly QuestionFact[] | null {
  if (value === undefined) return null
  const active = object(value).active
  if (!Array.isArray(active)) throw new Error('Invalid host user-question projection')
  const seen = new Set<string>()
  return active.map((candidate: unknown) => {
    const row = object(candidate)
    const callId = text(row.callId, 'question identity')
    if (row.state !== 'open' && row.state !== 'continued' || seen.has(callId)) throw new Error('Invalid host question state')
    seen.add(callId)
    return { callId, state: row.state }
  })
}

const INTERPRETED_EVENTS = new Set(['session/title', 'user/message', 'goal/change', 'turn/start', 'turn/end', 'step/start',
  'agent/inbox/spliced', 'request/header', 'tool/call', 'tool/result', 'tool/ptc-dispatch', 'approval/asked', 'approval/decided'])

export class LifecycleJournal {
  cursor = 0
  title: string
  activityAt: number | null = null
  lastEvent: SessionEvent | null = null
  private episode: Episode | null = null
  private turn: Turn | null = null
  private lastWorkTurn: Turn | null = null
  private goalState: GoalProjectionState = goalProjectionDefinition.init()
  private goalCompletion: { id: string; time: number } | null = null
  private timedSchema = false
  private sawTimedQuestion = false
  private readonly legacyQuestions = new Set<string>()
  private readonly approvals = new Set<string>()
  constructor(readonly header: SessionHeader, readonly inheritedEventCount: number) {
    integer(header.createdAt, 'session creation time')
    integer(inheritedEventCount, 'inherited event count')
    this.title = header.id
  }
  private anchor(seq: number, time: number, goalId: string | null): Episode {
    return { id: goalId === null ? `turn:${seq + 1}` : `goal:${digest(goalId).slice(0, 40)}:${seq + 1}`,
      order: seq + 1, startedAt: time, goalId, abandoned: false }
  }
  private enteredWork(human = false): void {
    const turn = this.turn
    if (turn === null || !turn.owned || turn.end !== null) return
    const alreadyEntered = turn.work
    turn.work = true
    // Once a turn consumed work, later model/tool steps belong to that exact
    // episode even if its goal was completed or paused inside an earlier tool.
    // The first real human admission still reopens an active automatic chain.
    if (alreadyEntered && !human) return
    const goal = this.goalState.current?.goal
    if (!human && goal?.phase === 'active' && this.episode?.goalId === goal.id && !this.episode.abandoned) return
    if (this.episode === null || this.episode.order < turn.seq + 1) this.episode = this.anchor(turn.seq, turn.time, goal?.phase === 'active' ? goal.id : null)
  }
  /** SDK-owned immutable events are accepted at this boundary. Validate fields used here,
   * including plugin-owned goal payloads through the SDK's strict replay fold. */
  append(event: SessionEvent): void {
    const envelope = object(event)
    const seq = integer(envelope.seq, 'event sequence')
    if (seq < this.cursor) return // the immutable canonical feed may repeat an already hydrated event
    if (seq !== this.cursor) throw new Error('Host journal has a sequence gap')
    const time = integer(envelope.time, 'event timestamp')
    const type = text(envelope.type, 'event type')
    if (type === 'user/message') {
      const source = object(object(envelope.data).source)
      text(source.kind, 'message source')
    }
    const previousGoal = this.goalState.current?.goal
    this.goalState = applyGoalProjection(this.goalState, event)
    if (this.goalState.failure !== null) throw new Error(this.goalState.failure)
    this.cursor = seq + 1
    this.lastEvent = event
    const owned = seq >= this.inheritedEventCount
    if (owned && (type.startsWith('turn/') || type.startsWith('step/') || ['user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(type))) this.activityAt = Math.max(this.activityAt ?? 0, time)
    // SessionEventMap is extensible and valid unrelated events may carry ANY JSON
    // value. Validate only the payloads this adapter interprets, not another
    // plugin's scalar/array/null vocabulary; the exact cursor and tail still advance.
    if (!INTERPRETED_EVENTS.has(type)) return
    const data = object(envelope.data)
    if (type === 'session/title') this.title = text(data.title, 'session title')
    // Boundary/schema history still folds through the inherited prefix, but it can
    // neither create a child episode nor copy the parent's completed progress.
    if (!owned && type !== 'turn/start' && type !== 'turn/end' && type !== 'request/header') return
    const currentGoal = this.goalState.current?.goal
    switch (type) {
      case 'turn/start': {
        const number = integer(data.turn, 'turn number', 1)
        if (this.turn !== null && this.turn.end === null) throw new Error('Host journal has nested open turns')
        this.turn = { number, seq, time, human: false, owned, work: false, stepped: false, end: null }
        this.legacyQuestions.clear(); this.approvals.clear()
        // The driver opens a turn BEFORE claiming input. A completely empty wake
        // also records completed; wait for claimed/admitted work before replacing
        // an accepted episode. The open boundary still revokes review freshness.
        break
      }
      case 'user/message': {
        const source = object(data.source)
        const human = source.kind === 'user' && this.turn !== null && !this.turn.human
        if (human && this.turn !== null) this.turn.human = true
        // A human prompt reopens even when an old goal is still active; automatic
        // goal-source rounds alone preserve the logical goal episode.
        this.enteredWork(human)
        break
      }
      case 'step/start': {
        if (this.turn === null || this.turn.end !== null || integer(data.turn, 'step turn', 1) !== this.turn.number) throw new Error('Host step has no matching open turn')
        this.turn.stepped = true
        this.enteredWork()
        break
      }
      case 'agent/inbox/spliced': {
        if (data.removedCount !== undefined && integer(data.removedCount, 'claimed inbox count') > 0 && data.outcome !== 'canceled') this.enteredWork()
        break
      }
      case 'turn/end': {
        const number = integer(data.turn, 'turn number', 1)
        const reason = object(data.reason)
        const kind = text(reason.kind, 'turn end reason')
        if (this.turn === null || this.turn.number !== number || this.turn.end !== null) throw new Error('Host turn end has no matching open turn')
        const cause = kind === 'aborted' && reason.reason !== undefined ? text(object(reason.reason).kind, 'turn cancellation cause') : null
        // Keep the structured LLM failure identity only: its message is unbounded
        // operator text and must never enter durable dashboard records.
        let error: TurnEndError | null = null
        if (kind === 'error' && reason.error !== undefined) {
          const failure = object(reason.error)
          const code = text(failure.code, 'turn end failure code').slice(0, 120)
          const status = failure.status === undefined ? undefined : integer(failure.status, 'turn end failure status', 100)
          if (status !== undefined && status > 599) throw new Error('Invalid host turn end failure status')
          error = status === undefined ? { code } : { code, status }
        }
        this.turn.end = { kind, cause, error, seq, time }
        if (this.turn.owned && this.turn.work) this.lastWorkTurn = this.turn
        this.legacyQuestions.clear(); this.approvals.clear()
        break
      }
      case 'goal/change': {
        const operation = text(data.operation, 'goal operation')
        if (operation === 'clear') {
          // Clearing is a tombstone, not an execution ending. Keep a completed
          // goal's settled result (including complete->clear inside its final tool),
          // but do not let a cleared unfinished goal borrow the remainder of its turn.
          if (previousGoal !== undefined && previousGoal.phase !== 'complete' && this.episode?.goalId === previousGoal.id) this.episode.abandoned = true
          break
        }
        if (currentGoal === undefined) throw new Error('Host goal change lacks current state')
        if (operation === 'create' || operation === 'resume') {
          this.episode = this.anchor(seq, time, currentGoal.id)
          this.goalCompletion = null
        }
        // Only the actual phase transition owns the logical completion time.
        // edit preserves phase and must neither create an episode for inherited
        // history nor rewrite completion/review time after the real turn ended.
        if (operation === 'complete') this.goalCompletion = { id: currentGoal.id, time }
        break
      }
      case 'request/header': {
        const tools = object(data.header).tools
        this.timedSchema = Array.isArray(tools) && tools.some((candidate: unknown) => {
          const tool = object(candidate)
          return typeof tool.name === 'string' && typeof tool.parameters === 'object' && tool.parameters !== null && !Array.isArray(tool.parameters)
            && isTimedQuestionSchema({ name: tool.name, parameters: object(tool.parameters) })
        })
        break
      }
      case 'tool/call': {
        const callId = text(data.callId, 'tool call identity')
        if (data.name === 'ask_user_question') {
          if (this.timedSchema) this.sawTimedQuestion = true
          else this.legacyQuestions.add(callId)
        }
        break
      }
      case 'tool/ptc-dispatch':
        // This event records a settled nested dispatch, not its start. rc.1
        // questions are blocking and already settled here; only timed-capable
        // hosts require the question projection to account for continued waits.
        if (data.name === 'ask_user_question' && installedHostCapabilities().timedQuestions) this.sawTimedQuestion = true
        break
      case 'tool/result': this.legacyQuestions.delete(text(object(data.message).toolCallId, 'tool result identity')); break
      case 'approval/asked': this.approvals.add(text(data.id, 'approval identity')); break
      case 'approval/decided': this.approvals.delete(text(data.id, 'approval identity')); break
    }
  }
  /** A missing timed question fold is a coverage failure, not an ordinary active tail. */
  requiresQuestionProjection(): boolean { return this.sawTimedQuestion }
  fact(environment: LifecycleEnvironment): RuntimeFact {
    const episode = this.episode
    const currentGoal = this.goalState.current
    const goal = episode !== null && currentGoal?.goal.id === episode.goalId ? currentGoal : null
    let sync: RuntimeFact['sync'] = 'synced'
    let phase: RuntimeFact['phase'] = 'not_started'
    let explanation: string | null = null
    let endedAt: number | null = null
    // The system's own turn-end reason, never a plugin-invented terminal kind. It
    // mirrors whichever end record decides this fact's phase; an unclosed run has no
    // closer yet, so it stays absent instead of guessing `interrupted`.
    let turnEnd: RuntimeFact['turnEnd']
    // Only the known union variants are exposed. A host that grows a new reason keeps
    // working exactly as before (no turnEnd, no validation failure) until this union
    // gains that variant; the dashboard never renames a system reason.
    const knownCauses: readonly TurnEndCause[] = ['user', 'parent', 'hook', 'disposed', 'legacy']
    const closer = (end: NonNullable<Turn['end']>): TurnEnd | null => {
      if (end.kind === 'completed' || end.kind === 'blocked' || end.kind === 'max-tokens' || end.kind === 'interrupted' || end.kind === 'forked') return { kind: end.kind }
      if (end.kind === 'aborted') return end.cause !== null && (knownCauses as readonly string[]).includes(end.cause) ? { kind: 'aborted', cause: end.cause as TurnEndCause } : null
      if (end.kind === 'error') return end.error !== null ? { kind: 'error', error: end.error } : null
      return null
    }
    const unknown = (message: string, display: RuntimeFact['phase'] = 'unknown') => { sync = 'unknown'; phase = display; explanation = message }
    const liveGoal = environment.goal
    if (environment.sourceLive && environment.goalAvailable && (
      (currentGoal === null) !== (liveGoal === null) || currentGoal !== null && liveGoal !== null &&
      (currentGoal.goal.id !== liveGoal.id || currentGoal.goal.revision !== liveGoal.revision || currentGoal.goal.phase !== liveGoal.phase || currentGoal.roundsStarted !== liveGoal.roundsStarted || currentGoal.goal.maxGoalRounds !== liveGoal.maxGoalRounds)
    )) unknown('宿主目标状态与同一日志切面不一致，请重新同步')
    else if (this.turn?.owned && this.turn.end === null && (!environment.sourceLive || environment.status !== 'running')) unknown('原始日志存在尚未闭合的执行；没有当前运行事实，不能推断正常完成或中断', 'suspended')
    else if (this.turn?.owned && this.turn.end !== null && !this.turn.work && this.turn.end.kind !== 'completed') unknown('宿主关闭了尚未确认消费工作的执行准备，无法将其当成新的正常成果')
    else if (environment.questions === null && this.sawTimedQuestion) unknown('宿主未提供计时问题投影，无法可靠核对等待输入状态')
    else if (environment.approvalWaits > 0) phase = 'waiting_approval'
    else if (environment.inputWaits > 0 || environment.questions !== null && environment.questions.length > 0) {
      phase = 'waiting_input'
      explanation = environment.questions?.some(question => question.state === 'continued') ? '问题仍可回答；工具前台等待结束不等于本轮完整完成' : '宿主正在等待用户输入'
    } else if (this.turn !== null && this.turn.owned && this.turn.end === null) {
      if (!environment.sourceLive || environment.status !== 'running') unknown('日志存在尚未闭合的执行；没有当前运行事实，不能推断正常完成或中断', 'suspended')
      else if (this.approvals.size > 0) unknown('日志有未配对授权记录，但没有可确认的当前授权等待；正在核对')
      else if (this.legacyQuestions.size > 0) { phase = 'waiting_input'; explanation = '当前完整执行中的阻塞式问题工具尚未返回' }
      else if (!this.turn.work) unknown('宿主已打开执行边界，尚未确认消费输入或进入模型步骤；空转不会生成待验收')
      else phase = 'running'
    } else if (episode !== null) {
      const lastEnd = this.lastWorkTurn?.end
      const end = lastEnd !== undefined && lastEnd !== null && lastEnd.seq + 1 >= episode.order ? lastEnd : null
      if (episode.abandoned && end !== null && end.kind !== 'completed') {
        phase = end.kind === 'error' ? 'failed' : end.kind === 'aborted' || end.kind === 'interrupted' || end.kind === 'forked' ? 'interrupted' : 'suspended'
        turnEnd = closer(end) ?? undefined
        explanation = end.kind === 'aborted' && end.cause === 'user' ? '用户已停止当前执行且未完成目标已清除；本轮不能验收' : `未完成目标已清除；宿主执行非正常结束：${end.kind}`
      } else if (episode.abandoned) { phase = 'suspended'; explanation = '未完成目标已清除；剩余工具、步骤或本轮结束不代表目标完成，需后续新执行' }
      else if (goal !== null && goal.goal.phase !== 'complete') {
        if (end !== null && end.kind !== 'completed' && end.kind !== 'blocked') {
          phase = end.kind === 'error' ? 'failed' : end.kind === 'aborted' || end.kind === 'interrupted' || end.kind === 'forked' ? 'interrupted' : 'suspended'
          turnEnd = closer(end) ?? undefined
          explanation = end.kind === 'aborted' && end.cause === 'user' ? '用户已停止当前执行；本轮没有正常完成，不能验收' : `宿主执行非正常结束：${end.kind}${end.cause === null ? '' : `（${end.cause}）`}`
        } else if (goal.goal.phase === 'paused' || goal.goal.phase === 'blocked') {
          phase = 'suspended'
          if (goal.goal.phase === 'blocked') {
            const reason = goal.goal.blockedReason
            if (reason === undefined) throw new Error('Host blocked goal lacks its validated reason')
            explanation = `目标已阻塞（${reason.code}）：${reason.message}`.slice(0, 1000)
          } else explanation = '目标已暂停；当前轮次正常结束不代表目标完成，等待显式恢复'
        } else if (!environment.sourceLive) { phase = 'suspended'; explanation = '持久化目标仍为活动状态；自动续跑授权仅在当前进程有效' }
        else if (!environment.goalAvailable || liveGoal === null) unknown('当前活动目标的自动续跑授权不可用，不能判断逻辑执行已结束')
        else if (liveGoal.activation === 'disarmed') { phase = 'suspended'; explanation = '活动目标在当前进程未获续跑授权，需人工恢复' }
        else { phase = 'continuation_pending'; explanation = '目标仍已激活；自动轮次间隙（包括轮次上限检查前）不提交验收' }
      } else if (end === null) {
        phase = 'suspended'; explanation = '尚无属于当前逻辑执行的完整正常结束记录'
      } else if (end.kind === 'completed' && !this.lastWorkTurn?.stepped) {
        phase = 'suspended'; turnEnd = closer(end) ?? undefined; explanation = '本次输入没有实际进入模型步骤；空转或被移除的输入不产生待验收成果'
      } else if (end.kind === 'completed') {
        phase = 'completed'; turnEnd = closer(end) ?? undefined
        endedAt = Math.max(end.time, episode.goalId !== null && this.goalCompletion?.id === episode.goalId ? this.goalCompletion.time : end.time)
      } else {
        phase = end.kind === 'error' ? 'failed' : end.kind === 'aborted' || end.kind === 'interrupted' || end.kind === 'forked' ? 'interrupted' : 'suspended'
        turnEnd = closer(end) ?? undefined
        explanation = end.kind === 'aborted' && end.cause === 'user' ? '用户已停止当前执行；本轮没有正常完成，不能验收' : `宿主执行非正常结束：${end.kind}${end.cause === null ? '' : `（${end.cause}）`}`
      }
    } else if (currentGoal !== null && currentGoal.goal.phase !== 'complete') {
      phase = 'suspended'; explanation = '继承目标没有属于本会话的新执行，需人工恢复'
    }
    if (sync === 'synced' && environment.pendingInput > 0 && (phase === 'completed' || phase === 'not_started')) { unknown('会话仍有待处理输入；尚未进入新执行不等于可靠未执行，暂不可验收或选择初始状态', 'continuation_pending'); turnEnd = undefined }
    if (sync === 'synced' && environment.status === 'running' && (phase === 'completed' || phase === 'not_started')) { unknown('宿主驱动正在准备或检查执行，但尚无更新的完整执行开始；暂不可验收'); turnEnd = undefined }
    if (sync === 'synced' && !environment.sourceLive && (phase === 'completed' || phase === 'not_started')) explanation = '这是持久化历史切面；请进入原会话等待宿主激活成功后重新同步，再进行人工验收'
    const goalPhase = goal?.goal.phase
    const attention: RuntimeFact['attention'] = sync !== 'synced' ? 'sync'
      : phase === 'waiting_input' ? 'answer' : phase === 'waiting_approval' ? 'approve'
      : phase === 'failed' ? 'failure' : phase === 'interrupted' ? 'interrupted'
      : phase !== 'suspended' ? 'none' : goalPhase === 'blocked' ? 'blocked'
      : goalPhase === 'paused' ? 'paused' : 'resume'
    const core = { sync, phase, attention, episodeId: episode?.id ?? null, episodeOrder: episode?.order ?? 0,
      startedAt: episode?.startedAt ?? null, endedAt, cursor: this.cursor, sourceLive: environment.sourceLive, explanation, activeAgents: environment.activeAgents ?? 0,
      ...(turnEnd === undefined ? {} : { turnEnd }) }
    return { ...core, fingerprint: digest({ sync, phase, episodeId: core.episodeId, episodeOrder: core.episodeOrder,
      startedAt: core.startedAt, endedAt, sourceLive: core.sourceLive, status: environment.status,
      // Terminal review identity excludes goal metadata/revision/clear. The exact
      // current goal projection and cursor are still checked above and by the host
      // capture fence; only a new actual episode or explicit resume reopens work.
      goal: goal !== null && phase !== 'completed' ? environment.goal : null,
      questions: environment.questions, input: environment.inputWaits, approval: environment.approvalWaits, pendingInput: environment.pendingInput }) }
  }
  /** Small, versioned journal state for a durable incremental fold checkpoint. It
   *  deliberately excludes `lastEvent` (the last full event can be huge and is only
   *  used as an append marker) and every prefix digest. */
  serialize(): LifecycleJournalState {
    return {
      version: 1, headerId: this.header.id, inheritedEventCount: this.inheritedEventCount, cursor: this.cursor,
      title: this.title, activityAt: this.activityAt,
      episode: this.episode === null ? null : clone(this.episode), turn: this.turn === null ? null : clone(this.turn), lastWorkTurn: this.lastWorkTurn === null ? null : clone(this.lastWorkTurn),
      goalState: clone(this.goalState), goalCompletion: this.goalCompletion === null ? null : { ...this.goalCompletion },
      timedSchema: this.timedSchema, sawTimedQuestion: this.sawTimedQuestion,
      legacyQuestions: [...this.legacyQuestions], approvals: [...this.approvals],
    }
  }
  static restore(header: SessionHeader, inheritedEventCount: number, state: LifecycleJournalState): LifecycleJournal {
    if (state.version !== 1 || state.headerId !== header.id || state.inheritedEventCount !== inheritedEventCount
      || !Number.isInteger(state.cursor) || state.cursor < 0 || typeof state.title !== 'string'
      || state.activityAt !== null && !Number.isFinite(state.activityAt)
      || !Array.isArray(state.legacyQuestions) || !state.legacyQuestions.every(value => typeof value === 'string')
      || !Array.isArray(state.approvals) || !state.approvals.every(value => typeof value === 'string')) {
      throw new Error('Lifecycle journal checkpoint does not match this session')
    }
    const journal = new LifecycleJournal(header, inheritedEventCount)
    journal.cursor = state.cursor
    journal.title = state.title
    journal.activityAt = state.activityAt
    journal.episode = state.episode === null ? null : clone(state.episode)
    journal.turn = state.turn === null ? null : clone(state.turn)
    journal.lastWorkTurn = state.lastWorkTurn === null ? null : clone(state.lastWorkTurn)
    journal.goalState = clone(state.goalState)
    journal.goalCompletion = state.goalCompletion === null ? null : { ...state.goalCompletion }
    journal.timedSchema = state.timedSchema === true
    journal.sawTimedQuestion = state.sawTimedQuestion === true
    for (const value of state.legacyQuestions) journal.legacyQuestions.add(value)
    for (const value of state.approvals) journal.approvals.add(value)
    return journal
  }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
