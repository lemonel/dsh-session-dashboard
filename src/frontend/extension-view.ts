import { effectiveTagIds, projectTagIds, type Board, type Card } from '../shared/model.js'
import type { DashboardHandshake } from '../shared/extension.js'
import type { DashboardCardView } from '../shared/slots.js'

/** Public props are detached and frozen; contributions cannot mutate the cache. */
export function publicHandshake(value: DashboardHandshake | null): DashboardHandshake | null {
  if (value === null) return null
  const result = structuredClone(value)
  Object.freeze(result.scope)
  for (const capability of Object.values(result.capabilities)) Object.freeze(capability)
  Object.freeze(result.capabilities)
  return Object.freeze(result)
}
export function uiSummary(board: Board | undefined, card: Card, cancellationGeneration: number | null = null): DashboardCardView {
  return { sessionId: card.sessionId, membershipId: card.membershipId, title: card.titleOverride || card.hostTitle || card.sessionId,
    projectId: card.projectId, tagIds: [...card.tagIds], projectTagIds: board ? projectTagIds(board, card) : [], effectiveTagIds: board ? effectiveTagIds(board, card) : [...card.tagIds], status: card.status,
    placement: structuredClone(card.placement), origin: structuredClone(card.origin), workflowRevision: card.workflowRevision, cancellationGeneration,
    episodeId: card.runtime.episodeId, lifecycleRevision: card.lifecycleRevision, metadataRevision: card.metadataRevision,
    archived: card.archivedAt !== null, hostArchive: { ...card.hostArchive }, attention: card.runtime.attention,
    sync: card.runtime.sync, sourceLive: card.runtime.sourceLive, phase: card.runtime.phase, endedAt: card.runtime.endedAt, reviewAt: card.reviewAt, turnEnd: card.runtime.turnEnd ? { ...card.runtime.turnEnd } : null }
}
