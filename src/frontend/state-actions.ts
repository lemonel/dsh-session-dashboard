import { canPickState, reviewBinding, reviewProblemKey, targetFor } from './view-model.js'
import type { DashboardClient } from './client.js'
import type { Card } from '../shared/model.js'

/** The same readiness rule the Dashboard uses: a snapshot we can trust and no
 *  service handoff in flight. Shared so the floating preview can run a state
 *  change even when the Dashboard panel is not mounted. */
export function stateReady(client: DashboardClient): boolean {
  const state = client.getSnapshot()
  return Boolean(state.snapshot && !state.transportError && !state.serviceChanged)
}

/** Move a settled round to a project state, or back to unset. Returns the saved
 *  card so callers can refresh whatever they render from it. */
export async function chooseState(client: DashboardClient, current: Card, stateId: string | null): Promise<Card | null> {
  const latest = client.getSnapshot(), board = latest.snapshot?.board
  if (!board || !latest.handshake || latest.serviceChanged || !stateReady(client)) { client.noticeKey('cannotChooseState'); return null }
  const row = board.cards.find(item => item.membershipId === current.membershipId)
  if (!row || !canPickState(row)) { client.noticeKey('cannotChooseState'); return null }
  const target = stateId ? targetFor(board, stateId) : null
  if (stateId && !target) { client.noticeKey('stateUnavailable'); return null }
  const result = await client.mutate({ type: 'choose_state', ...reviewBinding(row), selection: target ? { kind: 'custom', target } : { kind: 'unset' } })
  if (!result) return null
  client.noticeKey('stateChanged')
  return result.board.cards.find(item => item.membershipId === row.membershipId) ?? null
}

/** Run the acceptance path for a round waiting for review, optionally landing
 *  in a project state. */
export async function acceptState(client: DashboardClient, current: Card, stateId: string | null): Promise<boolean> {
  const latest = client.getSnapshot(), board = latest.snapshot?.board, ready = stateReady(client)
  if (!board || !ready || latest.serviceChanged) { client.noticeKey('cannotChooseState'); return false }
  const row = board.cards.find(item => item.membershipId === current.membershipId)
  if (!row) { client.noticeKey('confirmStale'); return false }
  // Choosing the destination is the human look that confirmation would otherwise
  // record. Both 待确认 and 待验收 accept in one server commit, so a failed review
  // can never leave a half-applied status change behind.
  const binding = reviewBinding(row)
  const problem = reviewProblemKey(row, 'accept', binding, ready)
  if (problem) { client.noticeKey(problem); return false }
  const target = stateId ? targetFor(board, stateId) : null
  if (stateId && !target) { client.noticeKey('stateUnavailable'); return false }
  const result = await client.mutate({ type: 'review', ...binding, action: 'accept', confirmed: true, destination: target ? { kind: 'custom', target } : { kind: 'stay' } })
  if (!result) return false
  client.noticeKey(target ? 'reviewSuccess' : 'acceptedOnlySuccess')
  return true
}
