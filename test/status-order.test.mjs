import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard } from '../lib/shared/model.js'
import { code, harness } from './helpers.mjs'

const NATIVES = ['in_progress', 'pending_confirm', 'pending_review', 'accepted']

test('C21 reordering the status dimension mixes built-ins with custom statuses and keeps built-ins mandatory', async t => {
  const h = harness(t)
  const status = await h.label('status', '开发')
  const board = h.store.read()
  const ids = ['pending_confirm', status.id, 'in_progress', 'pending_review', 'accepted']
  await h.mutate({ type: 'reorder', dimension: 'status', ids, expectedRevision: board.orders.status.revision })
  const reordered = h.store.read()
  assert.deepEqual(reordered.orders.status.ids, ids)
  await assert.rejects(h.mutate({ type: 'reorder', dimension: 'status', ids: ids.filter(id => id !== 'accepted'), expectedRevision: reordered.orders.status.revision }), code('INVALID'))
  await assert.rejects(h.mutate({ type: 'reorder', dimension: 'status', ids: [...ids, 'missing'], expectedRevision: reordered.orders.status.revision }), code('INVALID'))
})

test('C22 deleting a project keeps board-wide statuses untouched', async t => {
  const h = harness(t)
  const project = await h.label('project', '项目')
  const status = await h.label('status', '开发')
  const live = h.store.read().projects[0]
  assert.equal(live.revision, project.revision)
  await h.mutate({ type: 'delete_project', projectId: project.id, expectedProjectRevision: live.revision, confirmed: true })
  const after = h.store.read()
  assert.deepEqual(after.projects, [])
  assert.deepEqual(after.statuses.map(row => row.id), [status.id])
  assert.equal(after.orders.status.ids.includes(status.id), true)
})

test('C23 deleting a status unplaces its cards and prunes the status order', async t => {
  const h = harness(t)
  const { randomUUID } = await import('node:crypto')
  const status = await h.label('status', '开发')
  h.store.commit(null, board => {
    board.cards.push({
      sessionId: 'a', membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'A', titleOverride: null, workspace: null,
      projectId: null, tagIds: [], progress: '', status: 'accepted', placement: { kind: 'custom', statusId: status.id },
      origin: null, placementWitness: null, workflowRevision: 1,
      runtime: { sync: 'synced', phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, startedAt: 1, endedAt: 2, cursor: 2, sourceLive: true, fingerprint: 'cut', explanation: null, attention: 'none', activeAgents: 0 },
      decision: { kind: 'accepted', episodeId: 'turn:1', at: 2 }, joinedAt: 1, activityAt: 2, updatedAt: 2,
      reviewAt: null, acceptedAt: 2, archivedAt: null, metadataRevision: 1, lifecycleRevision: 1,
    })
    board.orders.status.ids = ['in_progress', status.id, 'pending_confirm', 'pending_review', 'accepted']
    board.orders.status.revision += 1
    return true
  })
  await h.mutate({ type: 'delete_label', dimension: 'status', id: status.id, expectedRevision: status.revision })
  const after = h.store.read()
  assert.deepEqual(after.statuses, [])
  assert.deepEqual(after.cards[0].placement, { kind: 'unset' })
  assert.deepEqual(after.orders.status.ids, NATIVES)
})

test('C24 built-in statuses are neither editable nor deletable', async t => {
  const h = harness(t)
  await assert.rejects(h.mutate({ type: 'update_label', dimension: 'status', id: 'in_progress', expectedRevision: 0, name: '进行中二', color: null }), code('FORBIDDEN'))
  await assert.rejects(h.mutate({ type: 'delete_label', dimension: 'status', id: 'accepted', expectedRevision: 0 }), code('FORBIDDEN'))
})
