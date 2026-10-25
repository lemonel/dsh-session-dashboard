import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { BusinessHistory } from '../lib/backend/history.js'
import { SqliteBoardStore, digestCommand, EVENT_RETENTION_MS } from '../lib/backend/store.js'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

function record(member, index = 1) {
  return { sessionId: 'a', membershipId: member, kind: 'state_changed', at: index, episodeId: null, origin: null, fromProjectId: null, toProjectId: null, from: { kind: 'unset' }, to: { kind: 'unset' }, fromProject: null, toProject: null, fromState: null, toState: null, decision: null, requestId: randomUUID() }
}
function memory(t) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); const history = new BusinessHistory(db); history.create(); return { db, history } }

test('v3 history is bounded per member, has explicit ascending cursor gaps and never expires with event time', t => {
  const { db, history } = memory(t), member = randomUUID()
  db.exec('BEGIN')
  for (let index = 1; index <= 1003; index++) history.append(record(member, index))
  db.exec('COMMIT')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM business_history').get().count, 1000)
  history.validate()
  const first = history.page({ sessionId: 'a', membershipId: member, limit: 100 })
  assert.equal(first.truncated, true); assert.equal(first.gap, false); assert.equal(first.records[0].sequence, 4); assert.equal(first.nextAfter, 103)
  assert.equal(first.highWatermark, 1003)
  const stale = history.page({ sessionId: 'a', membershipId: member, after: 0, limit: 100 })
  assert.equal(stale.gap, true); assert.equal(stale.records.length, 0)
  const next = history.page({ sessionId: 'a', membershipId: member, after: first.nextAfter, limit: 100 })
  assert.equal(next.records[0].sequence, 104)
  assert.equal(history.page({ sessionId: 'a', membershipId: member, after: 1004, limit: 100 }).gap, true)
  assert.throws(() => history.page({ sessionId: 'a', membershipId: randomUUID(), limit: 100 }), error => error.code === 'NOT_FOUND')
})

test('v3 history refuses to prune corrupted oldest rows and rolls back its watermark', t => {
  const { db, history } = memory(t), member = randomUUID()
  db.exec('BEGIN')
  for (let index = 1; index <= 1000; index++) history.append(record(member, index))
  db.exec('COMMIT')
  db.prepare('UPDATE business_history SET payload=? WHERE seq=1').run('{broken')
  const before = db.prepare('SELECT * FROM business_history WHERE seq=1').get()
  db.exec('BEGIN')
  assert.throws(() => history.append(record(member, 1001)), /integrity/)
  db.exec('ROLLBACK')
  assert.deepEqual(db.prepare('SELECT * FROM business_history WHERE seq=1').get(), before)
  assert.equal(db.prepare('SELECT high_watermark FROM history_meta WHERE id=1').get().high_watermark, 1000)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM business_history').get().count, 1000)
  assert.throws(() => history.validate(), /integrity/)
})

test('v3 history and receipt atomically rollback at final fence independently from rolling extension retention', t => {
  let now = 1000
  const store = new SqliteBoardStore(':memory:', 'test-history', () => now); t.after(() => store.close())
  const member = randomUUID(), base = { sessionId: 'a', membershipId: member, hostArchive: { state: 'active', reason: null }, hostTitle: 'A', titleOverride: null, workspace: null, projectId: null, tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'unset' }, origin: null, placementWitness: null, workflowRevision: 0, runtime: { sync: 'synced', phase: 'not_started', episodeId: null, episodeOrder: 0, startedAt: null, endedAt: null, cursor: 0, sourceLive: true, fingerprint: 'initial', explanation: null, attention: 'none', activeAgents: 0 }, decision: null, joinedAt: 1, activityAt: null, updatedAt: 1, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
  store.commit(null, board => { board.cards.push(base); return true })
  const receipt = { requestId: randomUUID(), digest: digestCommand('history-fence') }
  let calls = 0
  assert.throws(() => store.commit(receipt, board => { board.cards[0].placement = { kind: 'builtin', status: 'in_progress' }; board.cards[0].workflowRevision++; return true }, () => { if (++calls === 2) throw new Error('reject final authority') }), error => error.code === 'STORAGE')
  assert.equal(store.history({ sessionId: 'a', membershipId: member, limit: 100 }).records.length, 0)
  assert.equal(store.wasCommitted(receipt), false)
  store.commit(receipt, board => { board.cards[0].placement = { kind: 'builtin', status: 'in_progress' }; board.cards[0].workflowRevision++; return true })
  now += EVENT_RETENTION_MS + 10
  store.commit(null, board => { board.cards[0].progress = 'Later'; board.cards[0].metadataRevision++; return true })
  assert.equal(store.events(0, 100).gap, true)
  assert.equal(store.history({ sessionId: 'a', membershipId: member, limit: 100 }).records.length, 1)
})

test('v3 actual 100000-store capacity prunes globally and keeps explicit per-member cutoff', { timeout: 30000 }, t => {
  const { db, history } = memory(t), members = Array.from({ length: 101 }, () => randomUUID()), insert = db.prepare('INSERT INTO business_history VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  let sequence = 0
  for (const member of members) {
    const count = sequence < 100000 ? Math.min(1000, 100000 - sequence) : 0
    if (!count) continue
    db.prepare('INSERT INTO history_members VALUES (?, ?, ?, 0)').run(member, 'a', sequence + count)
    for (let n = 0; n < count; n++) { sequence++; const value = { ...record(member, sequence), schemaVersion: 1, id: randomUUID(), sequence }, payload = JSON.stringify(value); insert.run(sequence, member, payload, digestCommand(payload)) }
  }
  db.prepare('UPDATE history_meta SET high_watermark=?').run(sequence)
  db.exec('COMMIT')
  assert.equal(sequence, 100000)
  db.exec('BEGIN'); history.append(record(members[100], sequence + 1)); db.exec('COMMIT')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM business_history').get().count, 100000)
  assert.equal(db.prepare('SELECT MIN(seq) AS first, MAX(seq) AS last FROM business_history').get().first, 2)
  assert.equal(db.prepare('SELECT MIN(seq) AS first, MAX(seq) AS last FROM business_history').get().last, 100001)
  const pruned = history.page({ sessionId: 'a', membershipId: members[0], limit: 100 })
  assert.equal(pruned.truncated, true); assert.equal(pruned.records[0].sequence, 2)
  assert.equal(history.page({ sessionId: 'a', membershipId: members[0], after: 0, limit: 100 }).gap, true)
  history.validate()
})

test('v3 startup detects history metadata or payload corruption and preserves original bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-history-v3-')), path = join(root, 'dashboard.sqlite')
  t.after(() => { const target = realpathSync(root); assert.equal(dirname(target), realpathSync(tmpdir())); assert(target.startsWith(join(realpathSync(tmpdir()), 'dashboard-history-v3-'))); rmSync(target, { recursive: true, force: false }) })
  const store = new SqliteBoardStore(path); store.close()
  const db = new DatabaseSync(path); db.prepare('UPDATE history_meta SET high_watermark=-1').run(); db.close()
  assert.throws(() => new SqliteBoardStore(path), /watermark/)
  const inspector = new DatabaseSync(path); assert.equal(inspector.prepare('SELECT high_watermark FROM history_meta').get().high_watermark, -1); inspector.close()
})
