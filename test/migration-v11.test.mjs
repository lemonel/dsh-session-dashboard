import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteBoardStore, digestCommand } from '../lib/backend/store.js'
import { EMPTY, PROJECT_GROUP_ID, unknownRuntime } from '../lib/shared/model.js'

const PROJECT_ID = 'legacy-project', PUBLIC_TAG_ID = 'public-tag', MEMBERSHIP_ID = randomUUID()
function pathFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-dashboard-v10-'))
  t.after(() => rmSync(root, { recursive: true, force: false }))
  return join(root, 'dashboard.sqlite')
}
function legacyCard() {
  const runtime = { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, startedAt: 100, endedAt: 200, cursor: 4, fingerprint: 'turn:1:completed', explanation: null, attention: 'none' }
  return { sessionId: 'legacy', membershipId: MEMBERSHIP_ID, hostArchive: { state: 'active', reason: null }, hostTitle: 'Legacy', titleOverride: null, workspace: '/w', projectId: PROJECT_ID, tagIds: [], progress: 'kept', status: 'pending_review',
    placement: { kind: 'builtin', status: 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 0, runtime, decision: null,
    joinedAt: 1, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
}
const filters = () => ({ project: null, search: '', statuses: [], stateIds: [], tags: [], tagSource: 'effective', attention: 'all', hostArchive: 'all' })
const location = (x, y) => ({ x, y })

/** A real pre-v10 runtime board: one project with one public tag, one session. */
function seed(path) {
  const store = new SqliteBoardStore(path)
  store.commit(null, board => {
    board.tags.push({ id: PUBLIC_TAG_ID, name: '公共标签', color: '#abcdef', createdAt: 1, revision: 0, groupId: null })
    board.projects.push({ id: PROJECT_ID, name: 'Legacy project', color: '#123456', createdAt: 1, revision: 0, tagIds: [PUBLIC_TAG_ID] })
    board.orders.project.ids = [PROJECT_ID, EMPTY]; board.orders.project.revision += 1
    board.orders.tag.ids = [PUBLIC_TAG_ID]; board.orders.tag.revision += 1
    board.cards.push(legacyCard())
    return true
  })
  const runtime = store.read(), scope = store.identity()
  store.close()
  return { runtime, scope }
}
const readRow = (path, sql) => { const db = new DatabaseSync(path); try { return db.prepare(sql).get() } finally { db.close() } }
const readPayload = path => JSON.parse(readRow(path, 'SELECT payload FROM board WHERE id=1').payload)
/** Rewrite the seeded database as the selected pre-v10 version, digest included. */
function writeLegacy(path, runtime, version) {
  const legacy = version === 8
    ? {
        ...runtime, schemaVersion: 8,
        edges: [{ a: 'legacy', b: 'other' }],
        preferences: {
          revision: 5, entry: 'archive', selectedProjectId: null, groupBy: 'status',
          board: filters(), project: filters(), review: filters(), attention: filters(), unassigned: filters(), archive: filters(),
          locations: { status: location(1, 2), projects: location(11, 22), project: location(3, 4), tag: location(5, 6), review: location(7, 8), attention: location(9, 10), unassigned: location(13, 14), archive: location(15, 16) },
          collapsedProjects: ['legacy-project'],
        },
      }
    : { ...runtime, schemaVersion: 9 }
  const payload = JSON.stringify(legacy), db = new DatabaseSync(path)
  db.prepare('UPDATE board SET payload=?, digest=? WHERE id=1').run(payload, digestCommand(payload))
  if (version === 8) {
    db.exec('ALTER TABLE receipts ADD COLUMN committed_revision INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE memberships ADD COLUMN session_id TEXT')
  }
  db.exec(`PRAGMA user_version = ${String(version)}`)
  db.close()
}

function assertMigrated(path, { version, runtime, scope }) {
  const migrated = new SqliteBoardStore(path)
  const board = migrated.read()
  assert.equal(board.schemaVersion, 11)
  assert.deepEqual(migrated.identity(), scope)
  // The runtime projection still exposes projects and card.projectId.
  assert.deepEqual(board.projects, [{ id: PROJECT_ID, name: 'Legacy project', color: '#123456', createdAt: 1, revision: 0, tagIds: [PUBLIC_TAG_ID] }])
  assert.equal(board.cards.length, 1)
  assert.equal(board.cards[0].sessionId, 'legacy')
  assert.equal(board.cards[0].membershipId, MEMBERSHIP_ID)
  assert.equal(board.cards[0].progress, 'kept')
  assert.equal(board.cards[0].projectId, PROJECT_ID)
  assert.deepEqual(board.cards[0].tagIds, [])
  assert.deepEqual(board.orders.project.ids, [PROJECT_ID, EMPTY])
  assert.deepEqual(board.orders.tag.ids, [PUBLIC_TAG_ID])
  assert.equal(board.orders.project.revision, board.orders.tag.revision, 'one durable order feeds both runtime dimensions')
  if (version === 8) {
    assert.equal(board.preferences.entry, 'projects')
    assert.deepEqual(Object.keys(board.preferences).sort(), ['collapsedProjects', 'entry', 'locations', 'revision'])
    assert.deepEqual(Object.keys(board.preferences.locations), ['projects'])
    assert.deepEqual(board.preferences.locations.projects, { x: 11, y: 22 })
    assert.deepEqual(board.preferences.collapsedProjects, ['legacy-project'])
  } else assert.deepEqual(board.preferences, runtime.preferences)

  assert.deepEqual(board.orders.tagGroup.ids, board.tagGroups.map(group => group.id), 'the projection keeps the durable tag-group order')

  // Durable form: tag-only, one tag order, one tag-group order, builtin project group.
  const payload = readPayload(path)
  assert.equal(payload.schemaVersion, 11)
  assert.equal('projects' in payload, false)
  assert.equal('edges' in payload, false)
  assert.deepEqual(Object.keys(payload.orders).sort(), ['status', 'tag', 'tagGroup'])
  assert.deepEqual(payload.orders.tag.ids, [PROJECT_ID, PUBLIC_TAG_ID], 'the durable tag order folds in the project values')
  assert.deepEqual(payload.orders.tagGroup.ids, payload.tagGroups.map(group => group.id), 'a migrated v9 board gains the tag-group order it never stored')
  for (const row of payload.cards) { assert.equal('projectId' in row, false); assert.deepEqual(row.tagIds, [PROJECT_ID]) }
  const projectGroup = payload.tagGroups.find(group => group.id === PROJECT_GROUP_ID)
  assert.deepEqual(projectGroup, { id: PROJECT_GROUP_ID, name: '项目', color: null, builtin: true, revision: 0 })
  const projectTag = payload.tags.find(tag => tag.id === PROJECT_ID)
  assert.equal(projectTag.groupId, PROJECT_GROUP_ID)
  assert.deepEqual(projectTag.carriedTagIds, [PUBLIC_TAG_ID])
  const publicTag = payload.tags.find(tag => tag.id === PUBLIC_TAG_ID)
  assert.equal(publicTag.groupId, null)
  assert.deepEqual(publicTag.carriedTagIds, [])

  const db = new DatabaseSync(path)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
  assert.equal(db.prepare('PRAGMA table_info(receipts)').all().some(column => column.name === 'committed_revision'), false)
  assert.equal(db.prepare('PRAGMA table_info(memberships)').all().some(column => column.name === 'session_id'), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships').get().count, 1)
  db.close()

  // A reopen stays at 11 and does not rewrite the migrated row.
  const durable = JSON.stringify(readPayload(path))
  migrated.close()
  const reopened = new SqliteBoardStore(path)
  reopened.close()
  assert.equal(readRow(path, 'PRAGMA user_version').user_version, 11)
  assert.equal(JSON.stringify(readPayload(path)), durable)
}

for (const version of [8, 9]) {
  test(`v${String(version)} databases upgrade to the tag-only v11 board in place`, t => {
    const path = pathFor(t), seeded = seed(path)
    writeLegacy(path, seeded.runtime, version)
    assertMigrated(path, { version, ...seeded })
  })
}

test('v9 migration refuses a card holding two values of one tag group and leaves the file at v9', t => {
  const path = pathFor(t), seeded = seed(path)
  const board = structuredClone(seeded.runtime)
  board.tagGroups.push({ id: 'group-module', name: '模块', color: null, builtin: false, revision: 0 })
  board.orders.tagGroup.ids.push('group-module')
  board.tags.push(
    { id: 'module-a', name: '模块 A', color: null, createdAt: 1, revision: 0, groupId: 'group-module' },
    { id: 'module-b', name: '模块 B', color: null, createdAt: 1, revision: 0, groupId: 'group-module' },
  )
  board.orders.tag.ids.push('module-a', 'module-b')
  board.cards[0].tagIds = ['module-a', 'module-b']
  const payload = JSON.stringify({ ...board, schemaVersion: 9 }), db = new DatabaseSync(path)
  db.prepare('UPDATE board SET payload=?, digest=? WHERE id=1').run(payload, digestCommand(payload))
  db.exec('PRAGMA user_version = 9')
  db.close()

  assert.throws(() => new SqliteBoardStore(path), error => error.code === 'INVALID' && /同一标签组/.test(error.message))
  assert.equal(readRow(path, 'PRAGMA user_version').user_version, 9, 'a refused migration does not bump the version')
  assert.equal(JSON.stringify(readPayload(path)), payload, 'a refused migration leaves the original payload untouched')
})

test('a v10 tag-only database upgrades to v11 without a runtime round-trip', t => {
  const path = pathFor(t), seeded = seed(path)
  // Take the payload the current writer produces, then downgrade it to the exact
  // v10 shape: the tag-only durable form without orders.tagGroup.
  const legacy = readPayload(path)
  delete legacy.orders.tagGroup
  legacy.schemaVersion = 10
  const payload = JSON.stringify(legacy), db = new DatabaseSync(path)
  db.prepare('UPDATE board SET payload=?, digest=? WHERE id=1').run(payload, digestCommand(payload))
  db.exec('PRAGMA user_version = 10')
  db.close()

  const migrated = new SqliteBoardStore(path)
  const board = migrated.read()
  migrated.close()
  assert.equal(board.schemaVersion, 11)
  assert.deepEqual(board.projects, seeded.runtime.projects, 'the durable project values survive unchanged')
  assert.equal(board.cards.length, 1)
  assert.equal(board.cards[0].projectId, PROJECT_ID)
  assert.deepEqual(board.cards[0].tagIds, [])
  assert.deepEqual(board.orders.tagGroup.ids, board.tagGroups.map(group => group.id), 'the missing group order is filled from the groups')
  const upgraded = readPayload(path)
  assert.equal(upgraded.schemaVersion, 11)
  assert.equal('projects' in upgraded, false, 'a v10 payload is never projected back into the runtime shape on disk')
  assert.equal(readRow(path, 'PRAGMA user_version').user_version, 11)
})
