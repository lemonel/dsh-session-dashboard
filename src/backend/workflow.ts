import type { Board, Card, EpisodeOrigin, PlacementWitness, StateSnapshot } from '../shared/model.js'
import { sourcePrefixDigest, type SourceReplay } from './event-model.js'

export function sourceCut(source: SourceReplay | undefined, cursor: number): boolean {
  return source?.coverage === 'complete' && source.throughCursor === cursor && sourcePrefixDigest(source, cursor) !== null
}
export function statusSnapshot(board: Board, statusId: string): StateSnapshot | null {
  const status = board.statuses.find(row => row.id === statusId)
  return status ? { statusId, statusName: status.name, statusRevision: status.revision } : null
}
export function makeWitness(card: Card, source: SourceReplay | undefined, state: StateSnapshot | null): PlacementWitness | null {
  if (!sourceCut(source, card.runtime.cursor) || card.runtime.sync !== 'synced' || !card.runtime.sourceLive || !source) return null
  const prefixDigest = sourcePrefixDigest(source, source.throughCursor)
  if (prefixDigest === null) return null
  return { sourceIdentity: source.sourceIdentity, cursor: source.throughCursor, prefixDigest, workflowRevision: card.workflowRevision, state }
}
export function originFor(card: Card, source: SourceReplay | undefined, board?: Board): EpisodeOrigin | null {
  const runtime = card.runtime
  if (!runtime.episodeId) return null
  const base = { episodeId: runtime.episodeId, episodeOrder: runtime.episodeOrder }
  const witness = card.placementWitness
  if (!sourceCut(source, runtime.cursor) || !source) return { kind: 'unspecified', ...base, reason: 'source_unavailable' }
  const witnessDigest = sourcePrefixDigest(source, witness?.cursor ?? -1)
  if (!witness || witness.workflowRevision !== card.workflowRevision || source.sourceIdentity !== witness.sourceIdentity
    || witnessDigest !== witness.prefixDigest || runtime.episodeOrder <= witness.cursor) return { kind: 'unspecified', ...base, reason: 'unverified_start' }
  if (!witness.state) return { kind: 'unspecified', ...base, reason: 'no_state' }
  if (board) {
    const current = statusSnapshot(board, witness.state.statusId)
    if (!current || JSON.stringify(current) !== JSON.stringify(witness.state)) return { kind: 'unspecified', ...base, reason: 'unverified_start' }
  }
  return { kind: 'state', ...base, state: { ...witness.state } }
}
/** A current custom placement is not proof of the placement at an earlier anchor. */
export function refreshObservation(card: Card, beforeEpisode: string | null, source: SourceReplay | undefined, board?: Board): void {
  if (card.runtime.sync !== 'synced') {
    if (card.placementWitness) { card.placementWitness = null; card.workflowRevision += 1 }
    return
  }
  if (card.runtime.episodeId !== beforeEpisode) {
    card.origin = originFor(card, source, board)
    card.placement = { kind: 'builtin', status: card.status }
    card.workflowRevision += 1
    // A later actual episode may continue this same arrangement, but only after
    // this already verified cut; unknown starts stay unspecified.
    const state = card.origin?.kind === 'state' ? card.origin.state : null
    card.placementWitness = makeWitness(card, source, state)
  } else if (card.placement.kind !== 'builtin' && card.runtime.phase !== 'not_started' && !(card.status === 'accepted' && card.runtime.phase === 'completed')) {
    card.placement = { kind: 'builtin', status: card.status }; card.placementWitness = null; card.workflowRevision += 1
  } else if (source?.coverage === 'unavailable' && card.placementWitness) {
    card.placementWitness = null; card.workflowRevision += 1
  } else if (card.placement.kind === 'builtin' && card.placement.status !== card.status) {
    card.placement = { kind: 'builtin', status: card.status }; card.workflowRevision += 1
    if (card.placementWitness) card.placementWitness.workflowRevision = card.workflowRevision
  }
}
