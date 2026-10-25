import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, observation, replayFixture } from './helpers.mjs'

test('failed review capture withdraws freshness, returns degraded, dirty card recovers on snapshot', async t => {
  const h = harness(t); await h.add('a'); await h.service.snapshot()
  h.host.set('a', new Error('offline'), false)
  await assert.rejects(h.review('a', 'accept'), /offline/)
  const snapshot = await h.service.snapshot()
  assert.equal(snapshot.health.state, 'degraded'); assert.match(snapshot.health.message, /offline/)
  assert.equal(snapshot.board.cards[0].runtime.sync, 'unknown')
  h.host.set('a', observation(), false)
  const refreshed = await h.service.snapshot()
  assert.equal(refreshed.health.state, 'ready'); assert.equal(refreshed.board.cards[0].runtime.sync, 'synced')
})

test('removing unavailable card clears obsolete global health warning immediately', async t => {
  const h = harness(t); await h.add('a'); await h.add('b')
  h.host.set('a', new Error('gone')); await h.sync('a')
  assert.equal((await h.service.snapshot()).health.state, 'degraded')
  const snapshot = await h.mutate({ type: 'remove_card', sessionId: 'a', membershipId: h.card('a').membershipId, expectedMetadataRevision: h.card('a').metadataRevision, confirmed: true })
  assert.equal(snapshot.health.state, 'ready'); assert.equal(snapshot.health.message, null)
  h.host.setSource('b', replayFixture('b', h.card('b').runtime))
  await h.review('b', 'accept'); assert.equal(h.card('b').status, 'accepted')
})

test('unknown facts returned without throwing still make global health degraded', async t => {
  const h = harness(t); await h.add('a')
  h.host.set('a', observation('completed', 'turn:0', { sync: 'unknown', sourceLive: false, explanation: 'checkpoint failed' }))
  const snapshot = await h.sync('a')
  assert.equal(snapshot.health.state, 'degraded'); assert.match(snapshot.health.message, /checkpoint failed/)
})
