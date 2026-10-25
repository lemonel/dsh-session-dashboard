import test from 'node:test'
import assert from 'node:assert/strict'
import { completionCenter, MAX_COMPLETION_TOASTS, previewCenter, watchCompletions } from '../lib/frontend/completions.js'

const runtime = (extra = {}) => ({ phase: 'running', episodeId: 'turn:1', endedAt: null, cursor: 10, sourceLive: true, sync: 'synced', attention: 'none', activeAgents: 0, episodeOrder: 1, startedAt: null, fingerprint: 'x', explanation: null, ...extra })
const card = (phase, endedAt, extra = {}) => ({
  sessionId: 's1', membershipId: 'm1', hostTitle: 'Task session', titleOverride: null, projectId: 'p1', archivedAt: null,
  status: phase === 'completed' ? 'pending_review' : 'in_progress', decision: null, ...extra,
  runtime: runtime({ phase, endedAt, ...(extra.runtime ?? {}) }),
})
test('a newly completed tracked session emits one completion notice with project and title', () => {
  const listeners = new Set()
  let snapshot = { board: { cards: [card('running', null)], projects: [{ id: 'p1', name: 'Project One' }] } }
  const client = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ snapshot }) }
  const stop = watchCompletions(client)
  for (const listener of listeners) listener()
  snapshot = { board: { cards: [card('completed', 200)], projects: snapshot.board.projects } }
  for (const listener of listeners) listener()
  const state = completionCenter.getSnapshot()
  assert.equal(state.unread, true)
  assert.deepEqual(state.notice && { sessionId: state.notice.sessionId, title: state.notice.title, project: state.notice.project }, { sessionId: 's1', title: 'Task session', project: 'Project One' })
  const id = state.notice.id
  for (const listener of listeners) listener()
  assert.equal(completionCenter.getSnapshot().notice.id, id, 'the same completed cut does not notify twice')
  completionCenter.markRead()
  assert.equal(completionCenter.getSnapshot().unread, false)
  completionCenter.dismiss(id)
  assert.equal(completionCenter.getSnapshot().notice, null)
  stop()
})

test('a completed round notifies only after its running child agents finish', () => {
  for (const notice of completionCenter.getSnapshot().notices) completionCenter.dismiss(notice.id)
  const listeners = new Set()
  const client = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ snapshot }) }
  const tick = () => { for (const listener of listeners) listener() }
  let snapshot = { board: { cards: [card('running', null, { status: 'in_progress', runtime: { activeAgents: 1 } })], projects: [] } }
  const stop = watchCompletions(client); tick()
  // The main turn ended while a child agent still runs: not the main result yet.
  snapshot = { board: { cards: [card('completed', 300, { status: 'in_progress', runtime: { activeAgents: 1 } })], projects: [] } }
  tick()
  assert.equal(completionCenter.getSnapshot().notice, null, 'running child agents postpone the notification')
  snapshot = { board: { cards: [card('completed', 300, { status: 'pending_confirm', runtime: { activeAgents: 0 } })], projects: [] } }
  tick()
  const notice = completionCenter.getSnapshot().notice
  assert.equal(notice?.sessionId, 's1', 'the settled main result notifies once the children are done')
  assert.equal(notice?.episodeId, 'turn:1')
  if (notice) completionCenter.dismiss(notice.id)
  stop()
})

test('an archived completion does not notify', () => {
  for (const notice of completionCenter.getSnapshot().notices) completionCenter.dismiss(notice.id)
  const listeners = new Set()
  const client = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ snapshot }) }
  const tick = () => { for (const listener of listeners) listener() }
  let snapshot = { board: { cards: [card('running', null)], projects: [] } }
  const stop = watchCompletions(client); tick()
  snapshot = { board: { cards: [card('completed', 300, { archivedAt: 5 })], projects: [] } }
  tick()
  assert.equal(completionCenter.getSnapshot().notice, null)
  stop()
})

test('side-by-side keeps the open preview and adds the new Session as a second pane', () => {
  previewCenter.open({ sessionId: 'a', title: 'A' })
  previewCenter.open({ sessionId: 'b', title: 'B', sideBySide: true })
  assert.equal(previewCenter.getSnapshot().sessionId, 'a', 'the current preview stays the primary pane')
  assert.deepEqual(previewCenter.getSnapshot().split, { sessionId: 'b', title: 'B' })
  previewCenter.closeSplit()
  assert.equal(previewCenter.getSnapshot().split, null)
  assert.equal(previewCenter.getSnapshot().sessionId, 'a')
  previewCenter.close()
  assert.equal(previewCenter.getSnapshot(), null)
  previewCenter.open({ sessionId: 'c', title: 'C', sideBySide: true })
  assert.equal(previewCenter.getSnapshot().sessionId, 'c', 'without an open preview side-by-side degrades to a normal one')
  assert.equal(previewCenter.getSnapshot().split, undefined)
  previewCenter.close()
})

test('completion notices stack newest-first and drop the oldest past the cap', () => {
  for (let index = 0; index < MAX_COMPLETION_TOASTS + 1; index += 1) completionCenter.notify(`s${index}`, `T${index}`, `T${index}`, null, `ep${index}`)
  const notices = completionCenter.getSnapshot().notices
  assert.equal(notices.length, MAX_COMPLETION_TOASTS, 'the stack keeps a bounded number of notices')
  assert.deepEqual(notices.map(notice => notice.sessionId), ['s4', 's3', 's2', 's1'], 'newest first, oldest dropped')
  completionCenter.dismiss(notices[1].id)
  assert.deepEqual(completionCenter.getSnapshot().notices.map(notice => notice.sessionId), ['s4', 's2', 's1'], 'dismissing one keeps the rest')
  for (const notice of completionCenter.getSnapshot().notices) completionCenter.dismiss(notice.id)
  assert.equal(completionCenter.getSnapshot().notice, null)
  assert.deepEqual(completionCenter.getSnapshot().notices, [])
})
