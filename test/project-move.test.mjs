import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, observation, replayFixture, workflowBinding, code } from './helpers.mjs'

// This domain fixture explicitly opts into synthetic replay coverage. The native
// AgentLoop + durable JSONL tier remains separate and does not use this seam.
function completeSource(h, id) {
  const value = h.host.values.get(id)
  h.host.sources.set(id, replayFixture(id, value.runtime))
}
const moveCommand = (h, id, projectId, binding = workflowBinding(h.card(id))) => ({ type: 'move_project', ...binding, projectId, destination: { kind: 'preserve' }, expectedTargetProjectRevision: projectId === null ? null : h.store.read().projects.find(row => row.id === projectId)?.revision ?? 0 })
const fieldsExceptMove = card => { const { projectId, metadataRevision, workflowRevision, placementWitness, updatedAt, ...unchanged } = card; return unchanged }
const metadata = card => ({ sessionId: card.sessionId, membershipId: card.membershipId, projectId: card.projectId, tagIds: card.tagIds, titleOverride: card.titleOverride, progress: card.progress, archivedAt: card.archivedAt, metadataRevision: card.metadataRevision })

test('N02 moving a tracked built-in card preserves execution disposition, origin, own tags and handwritten fields; cold metadata stays cold', async t => {
  const h = harness(t)
  const source = await h.label('project', 'Source'), target = await h.label('project', 'Target')
  const tag = await h.label('tag', 'Topic')
  await h.add('move', 'completed', source.id); await h.add('related', 'completed', source.id)
  completeSource(h, 'move'); await h.sync('move')
  await h.edit('move', { titleOverride: 'Custom title', progress: 'Keep handwritten progress', tagIds: [tag.id] })
  await h.review('move', 'accept')
  const before = h.card('move'), command = moveCommand(h, 'move', target.id)
  await h.mutate(command); const after = h.card('move')
  assert.equal(after.projectId, target.id); assert.equal(after.metadataRevision, before.metadataRevision + 1)
  assert.ok(after.workflowRevision > before.workflowRevision); assert.equal(after.placementWitness, null)
  assert.ok(after.updatedAt > before.updatedAt)
  assert.deepEqual(fieldsExceptMove(after), fieldsExceptMove(before))
  assert.equal(h.store.read().cards.length, 2)
  h.host.set('move', observation('completed', 'turn:0', { sourceLive: false }), false)
  await h.sync('move')
  const coldBefore = h.card('move'); assert.equal(coldBefore.runtime.sync, 'synced'); assert.equal(coldBefore.runtime.sourceLive, false)
  await h.mutate(moveCommand(h, 'move', null))
  const coldAfter = h.card('move')
  assert.equal(coldAfter.projectId, null); assert.deepEqual(fieldsExceptMove(coldAfter), fieldsExceptMove(coldBefore))
  const sameVersion = coldAfter.metadataRevision
  await h.mutate(moveCommand(h, 'move', null))
  assert.equal(h.card('move').metadataRevision, sameVersion, 'same-project preserve is a no-op')
  assert.equal(h.store.read().cards.filter(card => card.sessionId === 'move').length, 1)
})

test('N02 a board-archived card cannot move or silently restore through project command', async t => {
  const h = harness(t), project = await h.label('project', 'Target')
  await h.add('archived'); await h.archive('archived', true)
  const before = h.card('archived')
  await assert.rejects(h.mutate(moveCommand(h, 'archived', project.id)), code('INVALID'))
  assert.deepEqual(metadata(h.card('archived')), metadata(before))
  assert.equal(h.card('archived').archivedAt, before.archivedAt)
})

test('N02 unavailable, missing or unknown host captures fail closed without project or metadata edits', async t => {
  const h = harness(t), project = await h.label('project', 'Target')
  for (const [id, badSource] of [
    ['unavailable', new Error('Host source unavailable')],
    ['missing', observation('completed', 'turn:0', { sync: 'missing', sourceLive: false, attention: 'sync' })],
    ['unknown', observation('completed', 'turn:0', { sync: 'unknown', sourceLive: false, attention: 'sync' })],
  ]) {
    await h.add(id)
    const before = metadata(h.card(id)), command = moveCommand(h, id, project.id)
    h.host.set(id, badSource, false)
    await assert.rejects(h.mutate(command), error => id === 'unavailable' ? /Host source unavailable/.test(error.message) : error.code === 'UNAVAILABLE')
    assert.deepEqual(metadata(h.card(id)), before)
    assert.notEqual(h.card(id).runtime.sync, 'synced', 'independent failure fact may withdraw freshness, not move project')
    assert.equal(h.card(id).status, 'pending_confirm', 'source failure does not invent another business status')
  }
})

test('N02 frozen stale workflow binding, nonexistent project and invalidated source cannot move the reliable card', async t => {
  const h = harness(t), project = await h.label('project', 'Target')
  await h.add('stale')
  const staleCommand = moveCommand(h, 'stale', project.id)
  await h.edit('stale', { progress: 'newer metadata from another window' })
  let before = metadata(h.card('stale'))
  await assert.rejects(h.mutate(staleCommand), code('CONFLICT'))
  assert.deepEqual(metadata(h.card('stale')), before)
  await assert.rejects(h.mutate(moveCommand(h, 'stale', 'nonexistent-project')), code('NOT_FOUND'))
  assert.deepEqual(metadata(h.card('stale')), before)
  const capture = h.host.capture.bind(h.host)
  h.host.capture = async id => { const result = await capture(id); return { ...result, validate: () => false } }
  before = metadata(h.card('stale'))
  await assert.rejects(h.mutate(moveCommand(h, 'stale', project.id)), code('REVIEW_STALE'))
  assert.deepEqual(metadata(h.card('stale')), before)
  assert.equal(h.store.read().cards.length, 1)
})
