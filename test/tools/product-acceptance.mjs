import assert from 'node:assert/strict'
import { workflowBinding, stateTarget } from '../helpers.mjs'

// Only explicit command construction and observation helpers live here. The real
// Loader/Gateway/AgentLoop, service, SQLite and JSONL own all product algorithms.
export { workflowBinding }
export const reason = (...values) => error => error.code === 'dashboard/error' && values.includes(error.details?.reason)
export const projectIn = (snapshot, id) => {
  const project = snapshot.board.projects.find(value => value.id === id)
  assert(project, `Project ${id} must exist in the checked snapshot`)
  return project
}
export const custom = (snapshot, statusId) => {
  const status = snapshot.board.statuses.find(value => value.id === statusId)
  assert(status, 'Destination must exist in the checked snapshot')
  return { kind: 'custom', target: stateTarget(status) }
}
export const choose = (checked, selection) => ({ type: 'choose_state', ...workflowBinding(checked), selection })
export const review = (checked, destination = { kind: 'stay' }, action = 'accept') => ({
  type: 'review', ...workflowBinding(checked), action, destination, confirmed: true,
})
export const move = (checked, snapshot, projectId, destination) => ({ type: 'move_project', ...workflowBinding(checked),
  projectId, destination, expectedTargetProjectRevision: projectId === null ? null : projectIn(snapshot, projectId).revision })
export async function project(h, name, tagIds = []) {
  const snapshot = await h.mutate({ type: 'create_project', name, color: null, tagIds })
  return snapshot.board.projects.find(value => value.name === name)
}
export async function state(h, name) {
  const snapshot = await h.mutate({ type: 'create_label', dimension: 'status', name, color: null })
  return snapshot.board.statuses.find(value => value.name === name)
}
export async function tag(h, name) {
  const snapshot = await h.mutate({ type: 'create_label', dimension: 'tag', name, color: null })
  return snapshot.board.tags.find(value => value.name === name)
}
export async function updateProject(h, checked, changes) {
  return h.mutate({ type: 'update_project', projectId: checked.id, expectedProjectRevision: checked.revision,
    name: checked.name, color: checked.color, tagIds: checked.tagIds, ...changes })
}
export async function updateState(h, statusId, changes) {
  const checked = (await h.snapshot()).board.statuses.find(value => value.id === statusId)
  assert(checked)
  return h.mutate({ type: 'update_label', dimension: 'status', id: statusId, expectedRevision: checked.revision,
    name: checked.name, color: checked.color, ...changes })
}
export const ownEdit = (checked, changes) => ({ type: 'edit_card', sessionId: checked.sessionId,
  membershipId: checked.membershipId, expectedMetadataRevision: checked.metadataRevision,
  tagIds: checked.tagIds, titleOverride: checked.titleOverride, progress: checked.progress, ...changes })
export async function summary(h, sessionId) {
  const value = await h.invoke('extensionSnapshot', { query: { apiVersion: 2, serviceId: h.handshake.serviceId } })
  return value.cards.find(card => card.sessionId === sessionId)
}
export const disposition = card => ({ placement: card.placement, status: card.status, episode: card.runtime.episodeId,
  origin: card.origin, decision: card.decision, reviewAt: card.reviewAt, acceptedAt: card.acceptedAt })
