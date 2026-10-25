import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, observation } from './helpers.mjs'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function drainEvents() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }

test('new event for already-processed card during later hydrate batch schedules another pass', async t => {
  const h = harness(t)
  for (const id of ['a', 'b', 'c', 'd', 'e']) await h.add(id)
  await h.service.snapshot()
  const reached = deferred(), release = deferred(), capture = h.host.capture.bind(h.host)
  let hold = true
  h.host.capture = async id => {
    if (id === 'e' && hold) { hold = false; reached.resolve(); await release.promise }
    return capture(id)
  }
  for (const id of ['a', 'b', 'c', 'd', 'e']) h.host.set(id, observation())
  await reached.promise
  h.host.set('a', observation('running', 'turn:20', { episodeOrder: 20, cursor: 21 }))
  release.resolve()
  await drainEvents()
  assert.equal(h.store.read().cards.find(card => card.sessionId === 'a').status, 'in_progress')
  assert.equal(h.store.read().cards.find(card => card.sessionId === 'a').runtime.episodeId, 'turn:20')
})

test('lifecycle persistence failure cannot advertise cached source as synced', async t => {
  const h = harness(t); await h.add('a'); await h.service.snapshot()
  const commit = h.store.commit.bind(h.store)
  h.store.commit = () => { throw new Error('lifecycle disk failed') }
  h.host.set('a', observation('running', 'turn:20', { episodeOrder: 20, cursor: 21 }))
  await drainEvents()
  const snapshot = await h.service.snapshot()
  assert.equal(snapshot.health.state, 'degraded')
  assert.equal(snapshot.board.cards[0].runtime.sync, 'unknown')
  assert.equal(snapshot.board.cards[0].runtime.sourceLive, false)
  assert.match(snapshot.health.message, /disk failed/)
  // No fabricated durable repair. Recovery uses the independent latest host fact.
  assert.equal(h.store.read().cards[0].status, 'pending_confirm')
  h.store.commit = commit
  const recovered = await h.service.snapshot()
  assert.equal(recovered.health.state, 'ready')
  assert.equal(recovered.board.cards[0].status, 'in_progress')
})

test('unrelated host traffic never creates an unbounded dirty queue', async t => {
  const h = harness(t); await h.add('tracked')
  let captures = 0
  const original = h.host.capture.bind(h.host)
  h.host.capture = id => { captures++; return original(id) }
  for (let n = 0; n < 1000; n++) h.host.set(`not-tracked-${n}`, observation())
  await drainEvents()
  assert.equal(captures, 0)
  assert.equal(h.store.read().cards.length, 1)
})
