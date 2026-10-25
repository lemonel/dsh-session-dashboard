import type { Board, Card, RuntimeFact } from '../shared/model.js'
import type { HostObservation } from '../shared/commands.js'
import type { SourceReplay } from './event-model.js'
import { refreshObservation } from './workflow.js'

/** Host facts and human dispositions have different owners. Replaying the same completed
 * episode may refresh its title/activity, but cannot undo accept/return/reopen. */
export function applyObservation(card: Card, observation: HostObservation, now: number, source?: SourceReplay, board?: Board): boolean {
  const before = JSON.stringify([card.placement, card.origin, card.placementWitness])
  const episode = card.runtime.episodeId
  const changed = applyRuntimeObservation(card, observation, now)
  refreshObservation(card, episode, source, board)
  const workflowChanged = before !== JSON.stringify([card.placement, card.origin, card.placementWitness])
  if (workflowChanged) card.updatedAt = now
  return changed || workflowChanged
}
function applyRuntimeObservation(card: Card, observation: HostObservation, now: number): boolean {
  const lifecycleBefore = card.lifecycleRevision
  const incoming = observation.runtime
  const previous = card.runtime
  if (incoming.sync === 'synced' && (incoming.cursor < previous.cursor || incoming.episodeOrder < previous.episodeOrder)) {
    // A durable prefix shorter than previously confirmed facts may mean rollback/crash loss.
    // Preserve the human result but withdraw freshness rather than endorsing a stale cache.
    const explanation = '宿主记录早于已确认轮次，请进入会话并重新同步；不能验收旧快照'
    if (previous.sync === 'unknown' && previous.explanation === explanation) return false
    card.runtime = { ...previous, sync: 'unknown', sourceLive: false, explanation, attention: 'sync' }
    card.lifecycleRevision += 1; card.updatedAt = now
    return true
  }
  if (incoming.sync === 'synced' && previous.phase === 'completed' && incoming.phase !== 'completed'
      && incoming.episodeId === previous.episodeId && incoming.episodeOrder === previous.episodeOrder) {
    // A genuine execution/resume must have a newer durable episode trigger. An old
    // waiting/start phase cannot erase a settled result or its human disposition.
    const explanation = '同轮终态与当前阶段不一致，保留已确认结果并等待重新同步'
    if (previous.sync === 'unknown' && previous.explanation === explanation) return false
    card.runtime = { ...previous, sync: 'unknown', sourceLive: false, explanation, attention: 'sync' }
    card.lifecycleRevision += 1; card.updatedAt = now
    return true
  }
  const runtime: RuntimeFact = incoming.sync === 'synced' ? incoming : {
    ...previous, sync: incoming.sync, sourceLive: false, explanation: incoming.explanation, attention: 'sync',
  }
  let changed = false
  if (JSON.stringify(card.hostArchive) !== JSON.stringify(observation.hostArchive)) {
    card.hostArchive = observation.hostArchive
    card.lifecycleRevision += 1
    changed = true
  }
  if (JSON.stringify(runtime) !== JSON.stringify(previous)) {
    card.runtime = runtime
    // Journal cursor/title-only updates remain persisted for source fencing, but do not
    // invalidate a human review of the exact same terminal result and conditions.
    if (runtime.sync !== previous.sync || runtime.phase !== previous.phase || runtime.episodeId !== previous.episodeId
        || runtime.episodeOrder !== previous.episodeOrder || runtime.startedAt !== previous.startedAt || runtime.endedAt !== previous.endedAt
        || runtime.sourceLive !== previous.sourceLive || runtime.fingerprint !== previous.fingerprint || runtime.attention !== previous.attention) card.lifecycleRevision += 1
    changed = true
  }
  if (incoming.sync === 'synced') {
    if (card.hostTitle !== observation.title) { card.hostTitle = observation.title; changed = true }
    if (card.workspace !== observation.workspace) { card.workspace = observation.workspace; changed = true }
    if (card.activityAt !== observation.activityAt) { card.activityAt = observation.activityAt; changed = true }
    const isNewEpisode = runtime.episodeId !== previous.episodeId || runtime.episodeOrder > previous.episodeOrder
    if (isNewEpisode) {
      card.decision = null; card.reviewAt = null; card.acceptedAt = null
      card.status = 'in_progress'
      changed = true
    }
    const handled = card.decision?.episodeId === runtime.episodeId && card.decision !== null
    const agentsRunning = (runtime.activeAgents ?? 0) > 0
    if (runtime.phase === 'completed' && runtime.episodeId && agentsRunning && !handled) {
      // The main turn ended while child agents still run: the round is not
      // settled, so it stays in progress. Entering 待确认 waits for them, and a
      // card that already reached 待确认 before their work showed up returns to
      // in progress. A human decision (handled) is never reversed here.
      if (card.status === 'in_progress' || card.status === 'pending_confirm') {
        if (card.status !== 'in_progress' || card.reviewAt !== null) {
          card.status = 'in_progress'; card.reviewAt = null; card.acceptedAt = null; changed = true
        }
      }
    } else if (runtime.phase === 'completed' && runtime.episodeId && !handled) {
      // A finished round waits for confirmation first; confirming (the user
      // opened the content) is what turns it into 待验收. Never downgrade a card
      // that is already past confirmation.
      if (card.status === 'in_progress') {
        card.status = 'pending_confirm'; card.reviewAt = runtime.endedAt; card.acceptedAt = null; changed = true
      } else if (card.reviewAt !== runtime.endedAt) {
        // Keep the recorded completion time equal to the current normal end.
        card.reviewAt = runtime.endedAt; changed = true
      }
    } else if (runtime.phase !== 'completed' && !(card.decision?.kind === 'historical' && runtime.phase === 'not_started')) {
      if (card.status !== 'in_progress' || card.reviewAt !== null || card.acceptedAt !== null) {
        card.status = 'in_progress'; card.reviewAt = null; card.acceptedAt = null; changed = true
      }
    }
  }
  // A single observation can change archive and runtime together; it is one CAS epoch.
  if (card.lifecycleRevision > lifecycleBefore) card.lifecycleRevision = lifecycleBefore + 1
  if (changed) card.updatedAt = now
  return changed
}
