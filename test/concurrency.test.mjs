import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { DashboardService } from '../lib/backend/service.js'
import { harness, FakeHost, observation, code, mutationFor, replayFixture } from './helpers.mjs'

function worker(path, source) {
  const storeUrl = new URL('../lib/backend/store.js', import.meta.url).href
  return new Promise((resolve, reject) => {
    const child = new Worker(`(async()=>{ const {parentPort,workerData}=require('node:worker_threads'); const {SqliteBoardStore}=await import(workerData.storeUrl); const store=new SqliteBoardStore(workerData.path); try { ${source}; parentPort.postMessage({ok:true}); } catch(error) { parentPort.postMessage({ok:false,message:error.message}); } finally { store.close(); } })().catch(error=>{throw error})`, { eval: true, workerData: { path, storeUrl } })
    child.on('message', result => result.ok ? resolve(result) : reject(new Error(result.message)))
    child.on('error', reject)
    child.on('exit', value => { if (value !== 0) reject(new Error(`worker exited ${value}`)) })
  })
}

test('real separate worker writers cannot lose aggregate updates or receipts', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-concurrency-')), 'dashboard.sqlite')
  const store = new SqliteBoardStore(path); t.after(() => store.close())
  await Promise.all(Array.from({ length: 4 }, (_, index) => worker(path, `for(let n=0;n<12;n++){store.commit({requestId:'worker-${index}-'+n,digest:'fixed'},board=>{board.preferences.revision++;return true})}`)))
  assert.equal(store.read().preferences.revision, 48)
  assert.equal(store.read().revision, 48)
})

test('two services sharing database enforce metadata CAS instead of last writer wins', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-window-')), 'dashboard.sqlite')
  const first = harness(t, path)
  await first.add('a')
  const secondStore = new SqliteBoardStore(path), secondHost = new FakeHost()
  secondHost.set('a', observation(), false)
  const second = new DashboardService(secondStore, secondHost); t.after(() => second.close())
  const original = first.card('a')
  await first.edit('a', { progress: 'window one' })
  await assert.rejects(second.mutate(mutationFor(second, { type: 'edit_card', sessionId: 'a', membershipId: original.membershipId, expectedMetadataRevision: original.metadataRevision, titleOverride: null, tagIds: [], progress: 'window two' })), code('CONFLICT'))
  assert.equal(secondStore.read().cards[0].progress, 'window one')
})

test('same UUID redelivery across independent service retains exactly-once result', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-redelivery-')), 'dashboard.sqlite'), h = harness(t, path)
  const requestId = randomUUID(), command = { type: 'create_project', name: 'one only', color: null, tagIds: [] }
  await h.mutate(command, requestId)
  const otherStore = new SqliteBoardStore(path), other = new DashboardService(otherStore, new FakeHost()); t.after(() => other.close())
  await assert.rejects(other.mutate(mutationFor(h.service, command, requestId)), code('UNAVAILABLE'))
  await other.mutate(mutationFor(other, command, requestId))
  assert.equal(otherStore.read().projects.length, 1)
})

test('unavailable source can be archived/restored without pretending it was verified', async t => {
  const h = harness(t); await h.add('a')
  h.host.set('a', new Error('source offline'))
  await h.archive('a', true)
  assert.notEqual(h.card('a').archivedAt, null); assert.equal(h.card('a').runtime.sync, 'unknown')
  await h.archive('a', false)
  assert.equal(h.card('a').archivedAt, null); assert.equal(h.card('a').runtime.sync, 'unknown')
})

test('new agent begins between latest capture and review transaction: refuses old confirmation', async t => {
  const h = harness(t); await h.add('a')
  h.host.setSource('a', replayFixture('a', h.card('a').runtime))
  const original = h.store.commit.bind(h.store)
  let armed = false
  h.store.commit = (receipt, change, fence) => {
    if (receipt && armed) { armed = false; h.host.set('a', observation('running', 'turn:20', { episodeOrder: 20, cursor: 21 })) }
    return original(receipt, change, fence)
  }
  armed = true
  await assert.rejects(h.review('a', 'accept'), code('REVIEW_STALE'))
  assert.equal(armed, false, 'the test really crossed the armed commit boundary')
  await h.sync('a')
  assert.equal(h.card('a').status, 'in_progress')
})

test('stale status order cannot drop a status created by a different process', async t => {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-orders-')), 'dashboard.sqlite'), h = harness(t, path)
  const previous = h.store.read().orders.status
  const otherStore = new SqliteBoardStore(path), other = new DashboardService(otherStore, new FakeHost()); t.after(() => other.close())
  await other.mutate(mutationFor(other, { type: 'create_label', dimension: 'status', name: 'new concurrent', color: null }))
  await assert.rejects(h.mutate({ type: 'reorder', dimension: 'status', ids: previous.ids, expectedRevision: previous.revision }), code('CONFLICT'))
  assert.equal(h.store.read().statuses.length, 1)
})
