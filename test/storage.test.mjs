import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { SqliteBoardStore, digestCommand } from '../lib/backend/store.js'
import { parseBoard } from '../lib/backend/invariants.js'
import { databasePath } from '../lib/backend/config.js'
import { emptyBoard, toStoredBoard } from '../lib/shared/model.js'
import { code, harness, observation, replayFixture } from './helpers.mjs'

const pathFor = () => join(mkdtempSync(join(tmpdir(), 'session-dashboard-store-')), 'dashboard.sqlite')
const readPayload = path => { const db = new DatabaseSync(path); try { return db.prepare('SELECT payload FROM board WHERE id=1').get().payload } finally { db.close() } }
test('A13 SQLite persists metadata, decisions, orders, preferences and receipts across reopen', async t => {
  const path = pathFor(), h = harness(t, path)
  const project = await h.label('project', '跨重启'), status = await h.label('status', '周末')
  await h.add('a', 'completed', project.id); h.host.setSource('a', replayFixture('a', h.card('a').runtime)); await h.review('a', 'accept')
  await h.mutate({ type: 'reorder', dimension: 'status', expectedRevision: 1, ids: [status.id, 'accepted', 'pending_confirm', 'pending_review', 'in_progress'] })
  const { revision, ...prefs } = h.store.read().preferences
  await h.mutate({ type: 'preferences', expectedRevision: revision, value: { ...prefs, entry: 'archive', locations: { projects: { x: 50, y: 500 } } } })
  const second = new SqliteBoardStore(path); t.after(() => second.close())
  const value = second.read()
  assert.equal(value.cards[0].status, 'accepted'); assert.equal(value.cards[0].projectId, project.id)
  assert.equal(value.cards[0].decision.kind, 'accepted')
  assert.deepEqual(value.statuses, [status])
  assert.deepEqual(value.orders.status.ids, [status.id, 'accepted', 'pending_confirm', 'pending_review', 'in_progress'])
  assert.equal(value.preferences.entry, 'archive'); assert.deepEqual(value.preferences.locations.projects, { x: 50, y: 500 })
})

test('A14 independent store handles see committed state, transaction rollback leaves no partial records', t => {
  const path = pathFor(), a = new SqliteBoardStore(path), b = new SqliteBoardStore(path)
  t.after(() => { a.close(); b.close() })
  a.commit(null, board => { board.preferences.entry = 'review'; board.preferences.revision++; return true })
  assert.equal(b.read().preferences.entry, 'review')
  // Order revisions come from the one durable tag order, so a writer's working copy
  // and a freshly projected row can expose different numbers there. The durable
  // payload and every persisted field must still match exactly.
  const before = b.read(), durable = readPayload(path)
  assert.throws(() => b.commit({ requestId: randomUUID(), digest: 'abc' }, board => { board.preferences.entry = 'archive'; throw new Error('disk failure simulation') }), code('STORAGE'))
  assert.equal(readPayload(path), durable, 'a failed transaction writes no board row')
  const after = a.read()
  assert.equal(after.preferences.entry, 'review')
  for (const key of ['cards', 'projects', 'tags', 'tagGroups', 'statuses', 'preferences']) assert.deepEqual(after[key], before[key], `the failed commit leaves ${key} untouched`)
  assert.deepEqual(after.orders.project.ids, before.orders.project.ids)
  assert.deepEqual(after.orders.tag.ids, before.orders.tag.ids)
  assert.deepEqual(after.orders.status, before.orders.status)
})

test('final host fence rejection rolls back data and idempotency receipt together', t => {
  const store = new SqliteBoardStore(':memory:'); t.after(() => store.close())
  const before = store.read(), requestId = randomUUID()
  let calls = 0
  assert.throws(() => store.commit({ requestId, digest: 'a' }, board => { board.preferences.entry = 'archive'; return true }, () => { if (++calls === 2) throw new Error('source changed') }), code('STORAGE'))
  assert.deepEqual(store.read(), before)
  const retry = store.commit({ requestId, digest: 'a' }, board => { board.preferences.entry = 'review'; return true })
  assert.equal(retry.duplicate, false); assert.equal(store.read().preferences.entry, 'review')
})

test('damaged aggregate fails closed, original payload is not silently rewritten', t => {
  const path = pathFor(), store = new SqliteBoardStore(path)
  store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE board SET payload=? WHERE id=1').run('{broken')
  db.close()
  const before = readFileSync(path)
  assert.throws(() => new SqliteBoardStore(path), /完整性/)
  assert.deepEqual(readFileSync(path), before)
})

test('valid hash is insufficient: cross-reference/order violations and unknown schema rejected', t => {
  const path = pathFor(), store = new SqliteBoardStore(path); store.close()
  const stored = toStoredBoard(emptyBoard()); stored.orders.tag.ids = ['ghost']
  const payload = JSON.stringify(stored), db = new DatabaseSync(path)
  db.prepare('UPDATE board SET payload=?, digest=? WHERE id=1').run(payload, digestCommand(payload)); db.close()
  assert.throws(() => new SqliteBoardStore(path), /顺序/)
  const future = pathFor(), other = new SqliteBoardStore(future); other.close()
  const f = new DatabaseSync(future); f.exec('PRAGMA user_version=99'); f.close()
  assert.throws(() => new SqliteBoardStore(future), /不支持/)
})

test('durable parser never trims existing strings or replaces malformed identities', () => {
  const board = emptyBoard()
  board.projects.push({ id: 'one', name: ' not canonical ', color: null, createdAt: 1, revision: 0, tagIds: [] })
  board.orders.project.ids.unshift('one')
  assert.throws(() => parseBoard(board), /规范格式/)
  assert.equal(board.projects[0].name, ' not canonical ')
})

test('A14 write failure does not report success or rollback independent lifecycle', async t => {
  const h = harness(t)
  await h.add('a', 'running')
  const original = h.store.commit.bind(h.store)
  h.store.commit = (receipt, change, fence) => { if (receipt) throw new Error('write unavailable'); return original(receipt, change, fence) }
  h.host.set('a', observation()); await h.sync('a')
  await assert.rejects(h.edit('a', { progress: 'unsaved' }), /write unavailable/)
  assert.equal(h.card('a').status, 'pending_confirm'); assert.equal(h.card('a').progress, '')
})

test('durable validation checks decision/status/round/timestamp associations, not only field types', async t => {
  const h = harness(t); await h.add('a'); h.host.setSource('a', replayFixture('a', h.card('a').runtime)); await h.review('a', 'accept')
  const board = h.store.read()
  const statusMismatch = structuredClone(board)
  statusMismatch.cards[0].status = 'in_progress'; statusMismatch.cards[0].placement = { kind: 'builtin', status: 'in_progress' }; statusMismatch.cards[0].acceptedAt = null
  assert.throws(() => parseBoard(statusMismatch), /决定与卡片进度/)
  const wrongTime = structuredClone(board); wrongTime.cards[0].acceptedAt++
  assert.throws(() => parseBoard(wrongTime), /验收时间/)
  const wrongVersion = structuredClone(board); wrongVersion.cards[0].metadataRevision = board.revision + 10
  assert.throws(() => parseBoard(wrongVersion), /卡片版本/)
})

test('a revision-keyed cold checkpoint skips the log read until the durable revision changes', async t => {
  const h = harness(t)
  await h.add('cold')
  h.host.probeValue = { live: false, headerDigest: 'header-1', inherited: 0, revision: 'revision-1', sizeBytes: 100, hostArchive: { state: 'active', reason: null } }
  await h.sync('cold')
  assert.ok(h.store.coldCheckpoint('cold'), 'the first cold capture records a checkpoint')
  const captures = h.host.captureCount
  await h.sync('cold')
  assert.equal(h.host.captureCount, captures, 'an unchanged revision reuses the observation without capturing')
  assert.equal(h.card('cold').runtime.sync, 'synced')
  h.host.probeValue = { ...h.host.probeValue, revision: 'revision-2' }
  await h.sync('cold')
  assert.equal(h.host.captureCount, captures + 1, 'a changed revision falls back to the authoritative capture')
})

test('a cold checkpoint survives a store reopen and avoids the first capture after restart', async t => {
  const path = pathFor(), first = harness(t, path)
  await first.add('restart')
  const probe = { live: false, headerDigest: 'restart-header', inherited: 0, revision: 'restart-revision', sizeBytes: 200, hostArchive: { state: 'active', reason: null } }
  first.host.probeValue = probe
  await first.sync('restart')
  const second = harness(t, path)
  second.host.set('restart', observation(), false)
  second.host.probeValue = probe
  await second.sync('restart')
  assert.equal(second.host.captureCount, 0, 'an unchanged cold session is restored without opening the log')
  assert.equal(second.card('restart').runtime.sync, 'synced')
})

test('profile-isolated default paths never fall back to cwd or cross-profile data', () => {
  const one = join(tmpdir(), 'profiles', 'one'), two = join(tmpdir(), 'profiles', 'two'), custom = join(tmpdir(), 'custom', 'data')
  assert.notEqual(databasePath({}, one), databasePath({}, two))
  assert.equal(databasePath({ dataDir: custom }, one), join(custom, 'dashboard.sqlite'))
  assert.throws(() => databasePath({}, ''), code('INVALID'))
  assert.throws(() => databasePath({ dataDir: 'relative' }, one), code('INVALID'))
  assert.throws(() => databasePath({ dataDir: custom }, ''), code('INVALID'))
})
