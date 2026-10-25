import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { storedBoardSchema } from '../lib/shared/model.js'
import { code, harness } from './helpers.mjs'

const pathFor = () => join(mkdtempSync(join(tmpdir(), 'session-dashboard-cache-')), 'dashboard.sqlite')
/** Count durable tag-only payload decodes through the public schema instance. The
 *  store calls the same module instance, so an unchanged cache must not reach this
 *  method; a commit validates its prospective durable board exactly once. */
function countBoardParses(t) {
  const original = storedBoardSchema.parse
  let count = 0
  storedBoardSchema.parse = function (value) { count += 1; return original.call(this, value) }
  t.after(() => { delete storedBoardSchema.parse })
  return () => count
}
const changeEntry = (entry, revision) => board => { board.preferences.entry = entry; board.preferences.revision += revision; return true }

test('the first load validates the persisted board once and warm reads never reparse it', t => {
  const parses = countBoardParses(t), store = new SqliteBoardStore(':memory:')
  t.after(() => store.close())
  assert.equal(parses(), 1, 'opening the database still validates the persisted board')
  store.read(); store.read(); store.identity(); store.snapshot(); store.snapshot()
  assert.equal(parses(), 1, 'warm reads, identities and snapshots reuse the parsed board')
})

test('snapshot and read return isolated boards and summaries that cannot pollute the cache', async t => {
  const h = harness(t)
  await h.add('a')
  const first = await h.service.snapshot(), pristine = structuredClone(first.board.cards[0])
  first.board.cards[0].runtime.sync = 'unknown'
  first.board.cards[0].progress = 'tampered'
  first.board.cards[0].placement = { kind: 'unset' }
  first.board.preferences.entry = 'review'
  const second = await h.service.snapshot()
  assert.equal(second.board.cards[0].runtime.sync, pristine.runtime.sync)
  assert.equal(second.board.cards[0].progress, '')
  assert.deepEqual(second.board.cards[0].placement, pristine.placement)
  assert.equal(second.board.preferences.entry, 'projects')

  const read = h.store.read()
  read.preferences.entry = 'archive'; read.cards[0].titleOverride = 'tampered'; read.cards[0].placement = { kind: 'unset' }
  assert.equal(h.store.read().preferences.entry, 'projects')
  assert.equal(h.store.read().cards[0].titleOverride, null)
  assert.deepEqual(h.store.read().cards[0].placement, pristine.placement)

  const summary = h.store.snapshot().cards[0]
  const summaryStatus = summary.status
  summary.status = 'accepted'; summary.phase = 'failed'
  assert.equal(h.store.snapshot().cards[0].status, summaryStatus)
  const scope = h.store.snapshot().scope
  scope.scopeId = '00000000-0000-4000-8000-000000000000'
  assert.notEqual(h.store.identity().scopeId, scope.scopeId)
})

test('commit publishes its cache only after COMMIT and a rejected commit keeps the previous cache', t => {
  const parses = countBoardParses(t), store = new SqliteBoardStore(':memory:')
  t.after(() => store.close())
  assert.equal(parses(), 1)
  store.commit(null, changeEntry('review', 1))
  assert.equal(parses(), 2, 'the prospective board is validated once before it is written')
  assert.equal(store.read().preferences.entry, 'review')
  assert.equal(parses(), 2, 'the committed board is served from the cache without a reparse')
  const before = store.snapshot(), entry = store.identity()
  assert.throws(() => store.commit(null, board => { board.preferences.entry = 'archive'; throw new Error('rejected by the change callback') }), code('STORAGE'))
  assert.equal(parses(), 2, 'a callback failure before validation changes nothing')
  let fences = 0
  assert.throws(() => store.commit(null, changeEntry('archive', 1), () => { if (++fences === 2) throw new Error('final authority rejected') }), code('STORAGE'))
  assert.equal(parses(), 3, 'the rejected attempt did validate its prospective board')
  assert.deepEqual(store.snapshot(), before, 'a rollback never publishes the uncommitted board')
  assert.deepEqual(store.identity(), entry, 'a rollback never publishes uncommitted meta')
  assert.equal(store.read().preferences.entry, 'review')
  assert.equal(parses(), 3, 'the rolled-back cache still matches the durable row, so no reparse is needed')
})

test('another connection invalidates the cache through the revision, payload and digest comparison', t => {
  const parses = countBoardParses(t), path = pathFor()
  const a = new SqliteBoardStore(path), b = new SqliteBoardStore(path)
  t.after(() => { a.close(); b.close() })
  const baseline = parses()
  assert.equal(a.read().preferences.entry, 'projects')
  assert.equal(parses(), baseline, 'a warm read of an unchanged row does not parse')
  b.commit(null, changeEntry('review', 1))
  assert.equal(parses(), baseline + 1)
  assert.equal(a.read().preferences.entry, 'review')
  assert.equal(parses(), baseline + 2, 'the other connection write forces one fresh parse')
  assert.equal(a.read().preferences.entry, 'review')
  assert.equal(parses(), baseline + 2)
})

test('a tampered payload with the old digest is rejected even with a warm cache', t => {
  const path = pathFor(), store = new SqliteBoardStore(path)
  t.after(() => store.close())
  store.commit(null, changeEntry('review', 1))
  const warm = store.read()
  const db = new DatabaseSync(path)
  const row = db.prepare('SELECT payload, digest FROM board WHERE id=1').get()
  const tampered = row.payload.replace('"entry":"review"', '"entry":"archive"')
  assert.notEqual(tampered, row.payload)
  db.prepare('UPDATE board SET payload=? WHERE id=1').run(tampered)
  assert.throws(() => store.read(), code('STORAGE'))
  assert.throws(() => store.snapshot(), code('STORAGE'))
  db.prepare('UPDATE board SET payload=? WHERE id=1').run(row.payload)
  db.close()
  assert.deepEqual(store.read(), warm, 'restoring the original row reuses the still-valid cache')
})

test('a tampered meta payload with the old digest is rejected even with a warm cache', t => {
  const path = pathFor(), store = new SqliteBoardStore(path)
  t.after(() => store.close())
  const identity = store.identity()
  const db = new DatabaseSync(path)
  const row = db.prepare('SELECT payload, digest FROM dashboard_meta WHERE id=1').get()
  const tampered = row.payload.replace(identity.scopeId, '00000000-0000-4000-8000-000000000000')
  assert.notEqual(tampered, row.payload)
  db.prepare('UPDATE dashboard_meta SET payload=? WHERE id=1').run(tampered)
  assert.throws(() => store.identity(), code('STORAGE'))
  assert.throws(() => store.snapshot(), code('STORAGE'))
  db.prepare('UPDATE dashboard_meta SET payload=? WHERE id=1').run(row.payload)
  db.close()
  assert.deepEqual(store.identity(), identity)
})

test('the first read always re-verifies the digest before any parse', t => {
  const path = pathFor(), fixture = new SqliteBoardStore(path)
  fixture.close()
  const db = new DatabaseSync(path), row = db.prepare('SELECT payload FROM board WHERE id=1').get()
  // Trailing whitespace keeps the JSON parseable while the stored digest goes stale.
  db.prepare('UPDATE board SET payload=? WHERE id=1').run(`${row.payload} `)
  db.close()
  const parses = countBoardParses(t)
  assert.throws(() => new SqliteBoardStore(path), code('STORAGE'))
  assert.equal(parses(), 0, 'the stale digest is rejected before the payload reaches the parser')
})

test('warm snapshots and identities avoid decoding the cached rows', t => {
  const path = pathFor(), store = new SqliteBoardStore(path)
  t.after(() => store.close())
  const db = new DatabaseSync(path)
  const payloads = [db.prepare('SELECT payload FROM board WHERE id=1').get().payload, db.prepare('SELECT payload FROM dashboard_meta WHERE id=1').get().payload]
  db.close()
  const original = JSON.parse, seen = []
  JSON.parse = function (text, reviver) { seen.push(text); return original.call(this, text, reviver) }
  try { store.identity(); store.read(); store.snapshot(); store.snapshot() } finally { JSON.parse = original }
  assert.deepEqual(seen.filter(text => payloads.includes(text)), [], 'warm calls never JSON.parse the cached board or meta payload')
})
