import { effectiveTagIds, projectTagIds, type Board, type Card } from '../shared/model.js'
import type { CardSummary, DomainEvent } from '../shared/extension.js'
import { digestCommand } from './store.js'

/** The session events a source fold must look at; both the full replay and the
 *  incremental fold use this one set. */
export const RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set(['turn/end', 'goal/change', 'tool/result', 'user/message'])
export interface CompletionEvidence { episodeId: string; cursor: number; endedAt: number; digest: string }
export interface SourceReplay {
  sessionId: string
  sourceIdentity: string
  /** Identity written by older builds before delegationDepth normalization. */
  legacySourceIdentity?: string
  /** Every safe compatibility identity (raw order / omitted default depth). */
  legacySourceIdentities?: readonly string[]
  throughCursor: number
  /** Chain digests at each prefix, including the empty prefix. A compact
   *  incremental source may leave this empty and use `prefixDigest` instead. */
  prefixDigests: readonly string[]
  /** Digest at `throughCursor` for a compact incremental checkpoint. */
  prefixDigest?: string
  /** Digest the compact checkpoint extends from, when it did not start at zero. */
  fromCursor?: number
  fromDigest?: string
  /** A bounded set of older checkpoint cuts carried by a compact source, so a
   *  previously committed member cut stays provable after the fold advances. */
  prefixHistory?: readonly { cursor: number; digest: string }[]
  completions: readonly CompletionEvidence[]
  coverage: 'complete' | 'unavailable'
  reason: string | null
  archiveVersion?: { sourceId: string; revision: number }
}
/** Digest at an arbitrary trusted cursor, supporting both a full prefix chain
 *  and a compact incremental checkpoint. */
export function sourcePrefixDigest(source: SourceReplay | undefined, cursor: number): string | null {
  if (!source) return null
  const digest = cursor === source.throughCursor ? source.prefixDigest : cursor === source.fromCursor ? source.fromDigest : undefined
  const value = digest ?? source.prefixHistory?.find(entry => entry.cursor === cursor)?.digest ?? source.prefixDigests[cursor]
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}
export function summarize(card: Card, cancellationGeneration = 0, board?: Board): CardSummary {
  return { sessionId: card.sessionId, membershipId: card.membershipId, title: card.titleOverride || card.hostTitle || card.sessionId,
    projectId: card.projectId, tagIds: [...card.tagIds], projectTagIds: board ? projectTagIds(board, card) : [], effectiveTagIds: board ? effectiveTagIds(board, card) : [...card.tagIds], status: card.status, placement: structuredClone(card.placement), origin: structuredClone(card.origin), workflowRevision: card.workflowRevision,
    episodeId: card.runtime.episodeId, lifecycleRevision: card.lifecycleRevision, metadataRevision: card.metadataRevision,
    cancellationGeneration, completionCoverage: 'unavailable', sourceIdentity: null, sourceCursor: null, completionEvidenceDigest: null, archived: card.archivedAt !== null, hostArchive: { ...card.hostArchive }, attention: card.runtime.attention,
    sync: card.runtime.sync, sourceLive: card.runtime.sourceLive, phase: card.runtime.phase, endedAt: card.runtime.endedAt, reviewAt: card.reviewAt, turnEnd: card.runtime.turnEnd ? { ...card.runtime.turnEnd } : null }
}
export type PendingEvent = Pick<DomainEvent, 'sessionId' | 'membershipId' | 'kind' | 'episodeId' | 'historical' | 'sourceIdentity' | 'sourceCursor' | 'evidenceDigest' | 'reason' | 'occurredAt'> & { card: Card | null }
const changed = (a: unknown, b: unknown): boolean => digestCommand(a) !== digestCommand(b)
export function boardEvents(before: Board, after: Board, at: number): PendingEvent[] {
  const previous = new Map(before.cards.map(card => [card.membershipId, card]))
  const next = new Map(after.cards.map(card => [card.membershipId, card]))
  const events: PendingEvent[] = []
  const add = (card: Card, kind: PendingEvent['kind'], historical = false) => events.push({ card, sessionId: card.sessionId, membershipId: card.membershipId, kind, episodeId: card.runtime.episodeId, historical, sourceIdentity: null, sourceCursor: null, evidenceDigest: null, reason: null, occurredAt: at })
  for (const card of after.cards) {
    const old = previous.get(card.membershipId)
    if (!old) { add(card, 'joined', true); continue }
    if (old.archivedAt !== card.archivedAt) add(card, card.archivedAt === null ? 'restored' : 'archived')
    if (changed(old.hostArchive, card.hostArchive)) add(card, 'host_archive')
    if (old.runtime.episodeId !== card.runtime.episodeId && card.runtime.episodeId !== null) add(card, 'episode_started')
    if (old.metadataRevision !== card.metadataRevision && old.archivedAt === card.archivedAt) add(card, 'metadata')
    if (changed(old.decision, card.decision)) add(card, 'decision')
    if (old.workflowRevision !== card.workflowRevision || changed(old.placement, card.placement) || changed(old.origin, card.origin)) add(card, 'workflow')
    if (old.projectId !== card.projectId || changed(old.tagIds, card.tagIds) || changed(projectTagIds(before, old), projectTagIds(after, card)) || changed(effectiveTagIds(before, old), effectiveTagIds(after, card))) add(card, 'project')
  }
  for (const card of before.cards) if (!next.has(card.membershipId)) add(card, 'removed')
  return events
}
