import { digest, LifecycleJournal, sourceHeaderDigest, sourceIdentityVariants } from './lifecycle.js'
import { RELEVANT_EVENT_TYPES as RELEVANT, type CompletionEvidence, type SourceReplay } from './event-model.js'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SourceFoldCheckpoint } from './store.js'

/** Build the compact source proof that an incrementally persisted fold needs.
 *  It keeps only the digest at the current cursor (plus the checkpoint it extends
 *  from), never the full prefix array. The lifecycle journal state is persisted
 *  alongside it so a resumed slice can continue without rereading history. */
export class SourceFoldBuilder {
  readonly sourceIdentity: string
  readonly legacySourceIdentity: string
  readonly legacySourceIdentities: readonly string[]
  /** Last persisted cut, used as the compact source's provable boundary. */
  private persistedCursor: number
  private persistedDigest: string
  private prefixDigest: string
  private readonly history: { cursor: number; digest: string }[] = []
  readonly journal: LifecycleJournal
  private readonly completions: CompletionEvidence[]
  private readonly seen = new Set<string>()
  readonly headerDigest: string

  constructor(header: SessionHeader, inherited: number, checkpoint?: SourceFoldCheckpoint) {
    const identities = sourceIdentityVariants(header, inherited)
    this.sourceIdentity = identities.identity
    this.legacySourceIdentities = identities.legacy
    this.legacySourceIdentity = identities.legacy[0] ?? identities.identity
    this.headerDigest = sourceHeaderDigest(header, inherited)
    if (checkpoint) {
      this.persistedCursor = checkpoint.cursor
      this.persistedDigest = checkpoint.prefixDigest
      this.prefixDigest = checkpoint.prefixDigest
      this.history.push(...(checkpoint.history ?? []))
      if (!this.history.some(entry => entry.cursor === 0)) this.history.unshift({ cursor: 0, digest: digest({ sourceIdentity: this.sourceIdentity }) })
      this.journal = LifecycleJournal.restore(header, inherited, checkpoint.journal)
      this.completions = [...checkpoint.completions]
      for (const completion of this.completions) this.seen.add(completion.episodeId)
    } else {
      this.persistedCursor = 0
      this.persistedDigest = digest({ sourceIdentity: this.sourceIdentity })
      this.prefixDigest = this.persistedDigest
      this.history.push({ cursor: 0, digest: this.persistedDigest })
      this.journal = new LifecycleJournal(header, inherited)
      this.completions = []
    }
  }

  get cursor(): number { return this.journal.cursor }

  /** Append one contiguous chunk. The journal rejects a sequence gap, so a stale
   *  checkpoint can never silently skip history. */
  append(events: readonly SessionEvent[]): void {
    for (const event of events) {
      const previous = this.prefixDigest
      this.journal.append(event)
      this.prefixDigest = digest({ previous, event })
      if (!RELEVANT.has(event.type)) continue
      // A timed-question log needs the full prefix projection to resolve question
      // state. The journal reports unknown instead, so this fold never invents a
      // completion; live capture still has the authoritative projection.
      const fact = this.journal.fact({ sourceLive: false, status: null, goal: null, goalAvailable: false, questions: null,
        inputWaits: 0, approvalWaits: 0, pendingInput: 0, activeAgents: 0 })
      if (fact.sync !== 'synced' || fact.phase !== 'completed' || fact.episodeId === null || fact.endedAt === null || this.seen.has(fact.episodeId)) continue
      this.seen.add(fact.episodeId)
      this.completions.push({ episodeId: fact.episodeId, cursor: this.journal.cursor, endedAt: fact.endedAt,
        digest: digest({ sourceIdentity: this.sourceIdentity, cursor: this.journal.cursor, prefix: this.prefixDigest, episodeId: fact.episodeId, endedAt: fact.endedAt }) })
    }
  }

  source(): SourceReplay {
    return {
      sessionId: this.journal.header.id, sourceIdentity: this.sourceIdentity, legacySourceIdentity: this.legacySourceIdentity, legacySourceIdentities: [...this.legacySourceIdentities],
      throughCursor: this.cursor, prefixDigests: [], prefixDigest: this.prefixDigest,
      fromCursor: this.persistedCursor, fromDigest: this.persistedDigest, prefixHistory: [...this.history],
      completions: [...this.completions], coverage: 'complete', reason: null,
    }
  }

  /** Exact cut at an earlier committed cursor. A background slice may have
   *  advanced past the observation, but a user operation must bind the exact
   *  card cursor instead of treating a newer source as the same cut. */
  sourceAt(cursor: number): SourceReplay | null {
    if (cursor === this.cursor) return this.source()
    const digest = cursor === this.persistedCursor ? this.persistedDigest
      : this.history.find(entry => entry.cursor === cursor)?.digest
    if (digest === undefined) return null
    return {
      sessionId: this.journal.header.id, sourceIdentity: this.sourceIdentity, legacySourceIdentity: this.legacySourceIdentity, legacySourceIdentities: [...this.legacySourceIdentities],
      throughCursor: cursor, prefixDigests: [], prefixDigest: digest,
      fromCursor: cursor, fromDigest: digest, prefixHistory: this.history.filter(entry => entry.cursor <= cursor),
      completions: this.completions.filter(completion => completion.cursor <= cursor), coverage: 'complete', reason: null,
    }
  }

  checkpoint(persistenceIdentity: string, revision: string, updatedAt: number): SourceFoldCheckpoint {
    if (this.cursor > this.persistedCursor) this.remember(this.persistedCursor, this.persistedDigest)
    const checkpoint: SourceFoldCheckpoint = {
      sessionId: this.journal.header.id, persistenceIdentity, headerDigest: this.headerDigest, inherited: this.journal.inheritedEventCount,
      revision, cursor: this.cursor, sourceIdentity: this.sourceIdentity, legacySourceIdentity: this.legacySourceIdentity,
      fromCursor: this.persistedCursor, fromDigest: this.persistedDigest, prefixDigest: this.prefixDigest, history: [...this.history],
      journal: this.journal.serialize(), completions: [...this.completions], updatedAt,
    }
    if (this.cursor > this.persistedCursor) { this.persistedCursor = this.cursor; this.persistedDigest = this.prefixDigest }
    return checkpoint
  }

  /** Keep every previously committed cut provable without an unbounded chain. */
  private remember(cursor: number, digest: string): void {
    if (this.history.some(entry => entry.cursor === cursor)) return
    this.history.push({ cursor, digest })
    if (this.history.length > 1024) this.history.splice(1, this.history.length - 1024)
  }

  static restore(header: SessionHeader, inherited: number, checkpoint: SourceFoldCheckpoint): SourceFoldBuilder {
    const headerDigest = sourceHeaderDigest(header, inherited)
    if (checkpoint.headerDigest !== headerDigest || checkpoint.inherited !== inherited
      || !Number.isInteger(checkpoint.fromCursor) || checkpoint.fromCursor < 0 || checkpoint.fromCursor > checkpoint.cursor
      || !/^[a-f0-9]{64}$/.test(checkpoint.fromDigest) || !/^[a-f0-9]{64}$/.test(checkpoint.prefixDigest)) {
      throw new Error('Source fold checkpoint does not match this session')
    }
    return new SourceFoldBuilder(header, inherited, checkpoint)
  }
}
