import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { LifecycleJournal, digest, sourceIdentityVariants, type QuestionFact } from './lifecycle.js'
import { RELEVANT_EVENT_TYPES as RELEVANT, type CompletionEvidence, type SourceReplay } from './event-model.js'

export const REPLAY_EVENT_LIMIT = 100000
export const REPLAY_BYTES_LIMIT = 32 * 1024 * 1024
const PROJECTION_WORK_LIMIT = 2000000
/** Raised when an incremental fold meets a timed-question log it cannot project from
 *  the retained tail alone; the caller must re-read and fold the full durable prefix. */
export class ReplayNeedsFullError extends Error {}
/** Raised when the projection-work budget is exhausted; callers report unavailable coverage. */
export class ReplayUnavailableError extends Error {
  constructor(readonly reason: string) { super(reason) }
}
/** A bounded incremental replay fold. Extending it only touches the newly read tail:
 *  the journal, prefix-digest chain and completion set stay in memory between captures,
 *  so a long live session does not re-fold and re-hash its whole log on every event. */
export class ReplayFold {
  readonly sourceIdentity: string
  readonly legacySourceIdentity: string
  readonly legacySourceIdentities: readonly string[]
  readonly prefixDigests: string[] = []
  readonly completions: CompletionEvidence[] = []
  private readonly journal: LifecycleJournal
  private readonly seen = new Set<string>()
  private count = 0
  /** JSON bytes of the event array's elements and separators; the outer brackets add 2. */
  private contentBytes = 0
  private projectionWork = 0
  constructor(readonly header: SessionHeader, readonly inherited: number, private readonly questionsAt: (prefix: readonly SessionEvent[]) => readonly QuestionFact[] | null) {
    const identities = sourceIdentityVariants(header, inherited)
    this.sourceIdentity = identities.identity
    this.legacySourceIdentities = identities.legacy
    // Keep the first compatibility identity for older readers; the store accepts
    // every variant because DSH may add the default depth field in either order.
    this.legacySourceIdentity = identities.legacy[0] ?? identities.identity
    this.journal = new LifecycleJournal(header, inherited)
    this.prefixDigests.push(digest({ sourceIdentity: this.sourceIdentity }))
  }
  get cursor(): number { return this.journal.cursor }
  get eventCount(): number { return this.count }
  requiresQuestionProjection(): boolean { return this.journal.requiresQuestionProjection() }
  snapshot(): SourceReplay {
    return { sessionId: this.header.id, sourceIdentity: this.sourceIdentity, legacySourceIdentity: this.legacySourceIdentity, legacySourceIdentities: [...this.legacySourceIdentities], throughCursor: this.journal.cursor,
      prefixDigests: [...this.prefixDigests], completions: [...this.completions], coverage: 'complete', reason: null }
  }
  /** Append events in sequence order. `prefixOf` is required only when the journal starts
   *  needing the timed-question projection; incremental callers omit it and fall back. */
  append(events: readonly SessionEvent[], prefixOf?: (cursor: number) => readonly SessionEvent[]): SourceReplay {
    const reason = this.limit(events)
    if (reason !== null) return unavailableReplay(this.header.id, reason)
    for (const event of events) {
      const encoded = JSON.stringify(event)
      const element = encoded === undefined ? 'null' : encoded
      const previous = this.prefixDigests.at(-1)
      this.journal.append(event)
      this.prefixDigests.push(digest({ previous, event }))
      this.count += 1
      this.contentBytes += Buffer.byteLength(element, 'utf8') + (this.count > 1 ? 1 : 0)
      if (!RELEVANT.has(event.type)) continue
      // Timed-question projection is only needed when this journal actually observed a
      // timed question tool. Passing null is the documented equivalent for other logs and
      // avoids re-folding the whole prefix for every relevant event.
      let questions: readonly QuestionFact[] | null = null
      if (this.journal.requiresQuestionProjection()) {
        if (!prefixOf) throw new ReplayNeedsFullError('timed question projection requires the full prefix')
        const prefix = prefixOf(this.journal.cursor)
        this.projectionWork += prefix.length
        if (this.projectionWork > PROJECTION_WORK_LIMIT) throw new ReplayUnavailableError('问题投影回放超过预算；当前逐轮覆盖不可用，不生成不完整完成流')
        questions = this.questionsAt(prefix)
      }
      const fact = this.journal.fact({ sourceLive: false, status: null, goal: null, goalAvailable: false, questions, inputWaits: 0, approvalWaits: 0, pendingInput: 0, activeAgents: 0 })
      if (fact.sync !== 'synced' && questions === null && this.journal.requiresQuestionProjection()) throw new ReplayUnavailableError('逐轮来源包含计时问题，但缺少可验证的问题投影；已关闭完成流且未推进可靠游标')
      if (fact.sync !== 'synced' || fact.phase !== 'completed' || fact.episodeId === null || fact.endedAt === null || this.seen.has(fact.episodeId)) continue
      this.seen.add(fact.episodeId)
      this.completions.push({ episodeId: fact.episodeId, cursor: this.journal.cursor, endedAt: fact.endedAt, digest: digest({ sourceIdentity: this.sourceIdentity, cursor: this.journal.cursor, prefix: this.prefixDigests[this.journal.cursor], episodeId: fact.episodeId, endedAt: fact.endedAt }) })
    }
    return this.snapshot()
  }
  /** Exact `Buffer.byteLength(JSON.stringify(events))` accounting for the whole fold,
   *  including bytes folded before this call. */
  private limit(events: readonly SessionEvent[]): string | null {
    if (this.count + events.length > REPLAY_EVENT_LIMIT) return CAPACITY
    let added = 0
    for (let index = 0; index < events.length; index += 1) {
      const encoded = JSON.stringify(events[index])
      added += Buffer.byteLength(encoded === undefined ? 'null' : encoded, 'utf8') + (this.count + index > 0 ? 1 : 0)
    }
    return this.contentBytes + added + 2 > REPLAY_BYTES_LIMIT ? CAPACITY : null
  }
}
const CAPACITY = '来源超过单次可靠回放容量，未开放逐轮自动化；请离线维护后显式建立新基线'
/** Exact `Buffer.byteLength(JSON.stringify(events))` without materializing the full JSON
 *  string. Returns the byte count, or null as soon as it provably exceeds `limit`.
 *  Array serialization uses '[' + comma-joined element JSON + ']'; JSON.stringify(undefined)
 *  elements become `null`, matching Array#toJSON behavior. */
export function replayByteLength(events: readonly unknown[], limit: number): number | null {
  let bytes = 1
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0) bytes += 1
    const encoded = JSON.stringify(events[index])
    bytes += Buffer.byteLength(encoded === undefined ? 'null' : encoded, 'utf8')
    if (bytes + 1 > limit) return null
  }
  bytes += 1
  return bytes <= limit ? bytes : null
}
export function unavailableReplay(sessionId: string, reason: string): SourceReplay {
  return { sessionId, sourceIdentity: digest({ sessionId, unavailable: true }), throughCursor: 0, prefixDigests: [digest(null)], completions: [], coverage: 'unavailable', reason: reason.slice(0, 1000) }
}
/** Replays durable raw records, NEVER prepared/repaired history. A terminal evidence record
 *  does not confer live human-review authority. Goal completion is folded by the same journal
 *  as current progress; an individual automatic turn is not mistaken for the whole Goal. */
export function replaySource(header: SessionHeader, inherited: number, events: readonly SessionEvent[], questionsAt: (prefix: readonly SessionEvent[]) => readonly QuestionFact[] | null): SourceReplay {
  const fold = new ReplayFold(header, inherited, questionsAt)
  try { return fold.append(events, cursor => events.slice(0, cursor)) }
  catch (error) {
    if (error instanceof ReplayUnavailableError) return unavailableReplay(header.id, error.reason)
    throw error
  }
}
