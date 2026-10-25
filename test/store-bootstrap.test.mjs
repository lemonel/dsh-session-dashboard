import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { unknownRuntime } from '../lib/shared/model.js'

function pathFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-dashboard-bootstrap-'))
  t.after(() => rmSync(root, { recursive: true, force: false }))
  return join(root, 'dashboard.sqlite')
}
function pendingCard() {
  const runtime = { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, startedAt: 100, endedAt: 200, cursor: 4, fingerprint: 'turn:1:completed', explanation: null, attention: 'none' }
  return { sessionId: 'boot', membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'Bootstrap', titleOverride: null, workspace: '/w', projectId: null, tagIds: [], progress: '', status: 'pending_review',
    placement: { kind: 'builtin', status: 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 0, runtime, decision: null,
    joinedAt: 1, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
}

test('a brand-new database creates the complete v11 schema and serves board plus history', t => {
  const path = pathFor(t), store = new SqliteBoardStore(path, 'fresh-profile')
  t.after(() => store.close())
  const board = store.read()
  assert.equal(board.schemaVersion, 11)
  assert.deepEqual(board.cards, [])
  const db = new DatabaseSync(path, { readOnly: true })
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
  for (const name of ['board', 'receipts', 'dashboard_meta', 'domain_events', 'memberships', 'business_history', 'history_meta', 'history_members', 'session_checkpoints']) assert.ok(tables.includes(name), `missing table ${name}: ${tables}`)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
  assert.equal(db.prepare("PRAGMA table_info(receipts)").all().some(row => row.name === 'committed_revision'), false, 'v11 never writes the retired receipt revision column')
  assert.equal(db.prepare("PRAGMA table_info(memberships)").all().some(row => row.name === 'session_id'), false, 'v11 never writes the retired membership session column')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dashboard_meta').get().count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history_meta').get().count, 1)
  // The first durable payload is already tag-only: no projects, no card.projectId,
  // one tag order, one tag-group order and the builtin project group.
  const payload = JSON.parse(db.prepare('SELECT payload FROM board WHERE id=1').get().payload)
  assert.equal(payload.schemaVersion, 11)
  assert.equal('projects' in payload, false)
  assert.deepEqual(Object.keys(payload.orders).sort(), ['status', 'tag', 'tagGroup'])
  assert.deepEqual(payload.orders.tagGroup.ids, payload.tagGroups.map(group => group.id))
  assert.equal(payload.tagGroups.some(row => row.id === '__project__' && row.builtin), true)
  for (const card of payload.cards) assert.equal('projectId' in card, false)
  db.close()

  store.commit(null, current => { current.cards.push(pendingCard()); return true })
  assert.equal(store.read().cards.length, 1)
  const added = store.read().cards[0]
  assert.deepEqual(store.history({ sessionId: 'boot', membershipId: added.membershipId, limit: 10 }).records, [], 'joining alone never invents history')

  store.commit(null, current => {
    const card = current.cards[0]
    card.status = 'accepted'; card.placement = { kind: 'builtin', status: 'accepted' }
    card.decision = { kind: 'accepted', episodeId: 'turn:1', at: 250 }; card.acceptedAt = 250; card.reviewAt = null; card.lifecycleRevision += 1
    return true
  })
  const history = store.history({ sessionId: 'boot', membershipId: added.membershipId, limit: 10 })
  assert.equal(history.records.length, 1)
  assert.equal(history.records[0].kind, 'accepted')
  assert.equal(history.highWatermark, 1)

  store.close()
  const reopened = new SqliteBoardStore(path, 'fresh-profile')
  t.after(() => reopened.close())
  assert.equal(reopened.read().schemaVersion, 11)
  assert.equal(reopened.read().cards[0].status, 'accepted')
  assert.equal(reopened.history({ sessionId: 'boot', membershipId: added.membershipId, limit: 10 }).records[0].kind, 'accepted')
})
