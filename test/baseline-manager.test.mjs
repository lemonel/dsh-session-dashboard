import test from 'node:test'
import assert from 'node:assert/strict'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { BaselineManager } from '../lib/backend/baseline-manager.js'
import { DashboardService } from '../lib/backend/service.js'
import { sourcePrefixDigest } from '../lib/backend/event-model.js'
import { mutationFor, observation } from './helpers.mjs'

const header = { id: 'long-session', version: 1, createdAt: 1, cwd: '/work/long' }
const event = seq => ({ seq, time: 10 + seq, type: 'unknown/plugin-event', data: { seq } })
const events = count => Array.from({ length: count }, (_, index) => event(index))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

class SliceHost {
  reads = []
  active = 0
  maxActive = 0
  constructor(count) { this.events = events(count) }
  async readSourceSlice(sessionId, from, max) {
    assert.equal(sessionId, header.id)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await delay(1)
      const slice = this.events.slice(from, from + max)
      this.reads.push({ from, count: slice.length })
      return { header, inherited: 0, persistenceIdentity: 'persistence-a', revision: 'rev-1', total: this.events.length,
        archiveVersion: { sourceId: 'archive-a', revision: 0 }, events: slice }
    } finally { this.active -= 1 }
  }
}

test('a short baseline folds inline, checkpoints, and resumes at its exact cursor', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new SliceHost(20)
  const first = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 500 })
  const cut = await first.source(header.id, 8)
  assert.equal(cut.state, 'ready')
  assert.equal(cut.source.throughCursor, 8)
  assert.ok(sourcePrefixDigest(cut.source, 0), 'the empty prefix stays provable')
  const checkpoint = store.sourceFold(header.id)
  assert.equal(checkpoint.cursor, 8)
  assert.equal(checkpoint.revision, 'rev-1')
  assert.match(checkpoint.headerDigest, /^[a-f0-9]{64}$/)
  assert.ok(checkpoint.history.some(entry => entry.cursor === 0))
  first.close()

  const resumed = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 500 })
  const before = host.reads.length
  const result = await resumed.source(header.id, 20)
  assert.equal(result.state, 'ready')
  assert.equal(result.source.throughCursor, 20)
  assert.equal(host.reads[before].from, 8, 'resume must start at the persisted cursor, not zero')
  assert.ok(sourcePrefixDigest(result.source, 8), 'the previous committed cut stays provable')
  resumed.close()
  store.close()
})

test('background chunks stay single-flight and complete an exact earlier cut from history', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new SliceHost(40)
  const manager = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 2, yieldMs: 1, sliceMs: 1000 })
  const first = await manager.source(header.id, 4)
  assert.equal(first.state, 'ready')
  let ready = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const next = await manager.source(header.id, 40)
    if (next.state === 'ready') { ready = next; break }
    await delay(2)
  }
  assert.ok(ready, 'background baseline never completed')
  assert.equal(ready.source.throughCursor, 40)
  assert.equal(host.maxActive, 1, 'the baseline worker must never read two slices at once')
  assert.ok(ready.source.prefixHistory.some(entry => entry.cursor === 4))
  const earlier = manager.peek(header.id, 4)
  assert.ok(earlier, 'a background-advanced fold must still prove the earlier card cut')
  assert.equal(earlier.throughCursor, 4)
  assert.equal(earlier.prefixDigest, sourcePrefixDigest(ready.source, 4))
  manager.close()
  store.close()
})

class LongHost {
  events = events(20)
  captureArgs = []
  listeners = new Set()
  async capture(sessionId, includeReplay = true) {
    this.captureArgs.push(includeReplay)
    return { observation: observation('completed', 'turn:2', { cursor: this.events.length }), validate: () => true, dispose() {} }
  }
  async probe() { return { live: true, eventCount: this.events.length, sizeBytes: 1024, hostArchive: { state: 'active', reason: null } } }
  async readSourceSlice(sessionId, from, max) {
    return { header, inherited: 0, persistenceIdentity: 'persistence-a', revision: 'rev-1', total: this.events.length,
      archiveVersion: { sourceId: 'archive-a', revision: 0 }, events: this.events.slice(from, from + max) }
  }
  async list() { return { items: [], total: 0, nextOffset: null } }
  async transcript() { return { messages: [], truncated: false } }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  close() { this.listeners.clear() }
}

test('a user mutation holds background slices and resumes them afterwards', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new SliceHost(60)
  const manager = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 1, yieldMs: 1, sliceMs: 1000 })
  const first = await manager.source(header.id, 4)
  assert.equal(first.state, 'ready')
  manager.ensure(header.id)
  const release = await manager.hold(header.id)
  const pausedAt = host.reads.length
  await delay(25)
  assert.equal(host.reads.length, pausedAt, 'no background slice may start while a user mutation holds the session')
  release()
  let ready = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const next = await manager.source(header.id, 60)
    if (next.state === 'ready') { ready = next; break }
    await delay(2)
  }
  assert.ok(ready, 'background work must resume after the user mutation releases the hold')
  manager.close()
  store.close()
})

test('a baseline requested while a user holds the session starts after release', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new SliceHost(30)
  const manager = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 1, yieldMs: 1, sliceMs: 1000 })
  const release = await manager.hold(header.id)
  manager.ensure(header.id)
  await delay(20)
  assert.equal(host.reads.length, 0, 'a queued baseline must not start during a user hold')
  release()
  let ready = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const next = await manager.source(header.id, 30)
    if (next.state === 'ready') { ready = next; break }
    await delay(2)
  }
  assert.ok(ready, 'a baseline queued during the hold must resume on release')
  manager.close()
  store.close()
})

test('a checkpoint bound to another session header is discarded and rebuilt', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new SliceHost(12)
  const first = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 500 })
  await first.source(header.id, 4)
  const checkpoint = store.sourceFold(header.id)
  store.saveSourceFold({ ...checkpoint, headerDigest: 'f'.repeat(64) })
  first.close()
  const before = host.reads.length
  const resumed = new BaselineManager(host, store, { batchEvents: 4, inlineMs: 500 })
  const result = await resumed.source(header.id, 12)
  assert.equal(result.state, 'ready')
  assert.equal(result.source.throughCursor, 12)
  assert.ok(host.reads.slice(before).some(read => read.from === 0), 'a checkpoint for another header must be discarded and rebuilt from zero')
  resumed.close()
  store.close()
})

test('a long session inspects and joins without a full host replay, then carries its baseline', async () => {
  const store = new SqliteBoardStore(':memory:')
  const host = new LongHost()
  const service = new DashboardService(store, host, undefined, undefined, { baselineEvents: 5 })
  try {
    const inspection = await service.inspectSession({ sessionId: header.id })
    assert.equal(host.captureArgs.every(value => value === false), true, 'inspection must not full-fold a long session')
    assert.ok(inspection.binding.sourceIdentity, 'the short baseline is available inline')
    await service.mutate(mutationFor(service, { type: 'add_card', sessionId: header.id, projectId: null, inspection: inspection.binding }))
    const card = store.snapshot().cards.find(row => row.sessionId === header.id)
    assert.equal(card.completionCoverage, 'complete')
    assert.equal(card.sourceIdentity, inspection.binding.sourceIdentity)
    assert.equal(card.sourceCursor, 20)
  } finally { await service.close() }
})
