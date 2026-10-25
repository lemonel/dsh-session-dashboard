import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { parseStoredBoard } from '../lib/backend/invariants.js'
import { EMPTY, PROJECT_GROUP_ID, emptyBoard, fromStoredBoard, toStoredBoard, unknownRuntime } from '../lib/shared/model.js'

/** A valid runtime card; durability only changes where its project lives. */
function card(tagIds, projectId = null) {
  const runtime = { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, startedAt: 100, endedAt: 200, cursor: 4, fingerprint: 'turn:1:completed', explanation: null, attention: 'none' }
  return { sessionId: 'session', membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'Session', titleOverride: null, workspace: '/w', projectId, tagIds: [...tagIds],
    progress: '', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 0, runtime, decision: null,
    joinedAt: 1, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
}

/** `tagIds` are the runtime card's own tags; `projectId` remains the project relation. */
function runtimeBoard(tagIds, projectId = null) {
  const board = emptyBoard()
  board.tagGroups = [
    { id: PROJECT_GROUP_ID, name: '项目', color: null, builtin: true, revision: 0 },
    { id: 'group-a', name: '组 A', color: null, builtin: false, revision: 0 },
  ]
  board.tags = [
    { id: 'a1', name: 'A1', color: null, createdAt: 1, revision: 0, groupId: 'group-a' },
    { id: 'a2', name: 'A2', color: null, createdAt: 1, revision: 0, groupId: 'group-a' },
    { id: 'u1', name: 'U1', color: null, createdAt: 1, revision: 0, groupId: null },
    { id: 'u2', name: 'U2', color: null, createdAt: 1, revision: 0, groupId: null },
  ]
  board.projects = [{ id: 'p1', name: '项目一', color: null, createdAt: 1, revision: 0, tagIds: ['u1'] }]
  board.orders.project.ids = ['p1', EMPTY]; board.orders.project.revision = 1
  board.orders.tag.ids = ['a1', 'a2', 'u1', 'u2']; board.orders.tag.revision = 1
  board.cards = [card(tagIds, projectId)]
  return board
}
const invalid = pattern => error => error.code === 'INVALID' && pattern.test(error.message)
/** Order revisions are the one value a single durable tag order cannot preserve per
 *  runtime dimension; every other field must survive the roundtrip exactly. */
const withoutOrderRevisions = board => {
  const copy = structuredClone(board)
  copy.orders.project.revision = 0; copy.orders.tag.revision = 0; copy.orders.tagGroup.ids = []
  return copy
}

test('the durable board is tag-only: projects are values of the builtin project group', () => {
  const stored = toStoredBoard(runtimeBoard(['a1', 'u1']))
  assert.equal('projects' in stored, false)
  assert.deepEqual(Object.keys(stored.orders).sort(), ['status', 'tag', 'tagGroup'])
  assert.equal('project' in stored.orders, false)
  assert.equal(stored.tagGroups.find(group => group.id === PROJECT_GROUP_ID).builtin, true)
  const projectTag = stored.tags.find(tag => tag.id === 'p1')
  assert.equal(projectTag.groupId, PROJECT_GROUP_ID)
  assert.deepEqual(projectTag.carriedTagIds, ['u1'])
  assert.deepEqual(stored.tags.filter(tag => tag.groupId !== PROJECT_GROUP_ID).map(tag => tag.carriedTagIds), [[], [], [], []])
  for (const row of stored.cards) assert.equal('projectId' in row, false)
  assert.deepEqual(stored.cards[0].tagIds, ['a1', 'u1'])
})

test('one tag per group is accepted, including a project value plus one own tag', () => {
  const plain = parseStoredBoard(toStoredBoard(runtimeBoard(['a1', 'u1'])))
  assert.equal(plain.cards[0].projectId, null)
  assert.deepEqual(plain.cards[0].tagIds, ['a1', 'u1'])
  const withProject = parseStoredBoard(toStoredBoard(runtimeBoard(['a1'], 'p1')))
  assert.equal(withProject.cards[0].projectId, 'p1')
  assert.deepEqual(withProject.cards[0].tagIds, ['a1'])
})

test('two values of one tag group on a card are rejected by the durable parser', () => {
  assert.throws(() => parseStoredBoard(toStoredBoard(runtimeBoard(['a1', 'a2']))), invalid(/同一标签组/))
})

test('two ungrouped tags are two values of one implicit group and are rejected', () => {
  assert.throws(() => parseStoredBoard(toStoredBoard(runtimeBoard(['u1', 'u2']))), invalid(/同一标签组/))
})

test('carried tags belong to project tags only and the builtin project group is mandatory', () => {
  const carried = toStoredBoard(runtimeBoard([]))
  carried.tags.find(tag => tag.id === 'u2').carriedTagIds = ['a1']
  assert.throws(() => parseStoredBoard(carried), invalid(/只有项目标签/))
  const missingGroup = toStoredBoard(runtimeBoard([]))
  missingGroup.tagGroups = missingGroup.tagGroups.filter(group => group.id !== PROJECT_GROUP_ID)
  assert.throws(() => parseStoredBoard(missingGroup), invalid(/缺少内置项目标签组/))
})

test('the durable schema rejects the runtime shape instead of silently tolerating it', () => {
  assert.throws(() => parseStoredBoard(emptyBoard()))
  const future = toStoredBoard(runtimeBoard([])); future.schemaVersion = 9
  assert.throws(() => parseStoredBoard(future))
})

test('roundtripping a runtime board preserves its content and its split order ids', () => {
  for (const [tagIds, projectId] of [[[], null], [['a1'], null], [['a1', 'u1'], null], [['a1', 'u2'], 'p1']]) {
    const board = runtimeBoard(tagIds, projectId), stored = toStoredBoard(board), projected = fromStoredBoard(stored)
    assert.deepEqual(projected.orders.project.ids, board.orders.project.ids)
    assert.deepEqual(projected.orders.tag.ids, board.orders.tag.ids)
    assert.deepEqual(projected.orders.tagGroup.ids, stored.orders.tagGroup.ids, 'the tag-group order is one durable list the projection reuses')
    assert.deepEqual(withoutOrderRevisions(projected), withoutOrderRevisions(board))
  }
})
