import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { harness, code, workflowBinding, replayFixture } from './helpers.mjs'

test('A14/A18 remove→re-add cannot reuse a previous metadata or acceptance token', async t => {
  const h = harness(t), project = await h.label('project', 'new project')
  await h.add('a')
  const old = h.card('a')
  await h.mutate({ type: 'remove_card', sessionId: 'a', membershipId: old.membershipId, expectedMetadataRevision: old.metadataRevision, confirmed: true })
  await h.add('a', 'completed', project.id)
  const current = h.card('a')
  assert(current.metadataRevision > old.metadataRevision)
  assert(current.lifecycleRevision > old.lifecycleRevision)
  await assert.rejects(h.edit('a', { progress: 'stale overwrite', membershipId: old.membershipId }, old.metadataRevision), code('CONFLICT'))
  await assert.rejects(h.review('a', 'accept', workflowBinding(old)), code('CONFLICT'))
  assert.equal(h.card('a').projectId, project.id)
})

test('success retry after host loss is a receipt, not a new verification or repeated accept', async t => {
  const h = harness(t); await h.add('a')
  h.host.setSource('a', replayFixture('a', h.card('a').runtime))
  await h.confirm('a')
  const card = h.card('a'), requestId = randomUUID()
  const command = { type: 'review', ...workflowBinding(card), action: 'accept', confirmed: true, destination: { kind: 'stay' } }
  await h.mutate(command, requestId)
  const accepted = h.card('a')
  h.host.set('a', new Error('offline'), false)
  const retried = await h.mutate(command, requestId)
  assert.equal(retried.board.cards[0].acceptedAt, accepted.acceptedAt)
  assert.equal(retried.board.cards[0].lifecycleRevision, accepted.lifecycleRevision)
})

