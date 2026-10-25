import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard, unknownRuntime, PROJECT_GROUP_ID } from '../lib/shared/model.js'
import { dimensionBuckets, dimensionName, dimensionOptions, PROJECT_DIMENSION, STATUS_DIMENSION, UNGROUPED_DIMENSION } from '../lib/frontend/board-dimensions.js'

const t = key => ({ unsetGroup: '未设置', groupNone: '未分组', status: '状态', projectsHome: '项目总览', unsetState: '未设置状态' })[key] ?? key
const label = (id, name, extra = {}) => ({ id, name, color: null, createdAt: 1, revision: 0, ...extra })
const card = (id, extra = {}) => ({ sessionId: id, membershipId: `${id}-membership`, hostArchive: { state: 'active', reason: null }, hostTitle: id, titleOverride: null, workspace: '/w', projectId: null, tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null, workflowRevision: 0, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, attention: 'none' }, decision: null, joinedAt: 1, activityAt: 2, updatedAt: 2, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0, ...extra })

function board() {
  const value = emptyBoard()
  value.tagGroups = [label(PROJECT_GROUP_ID, '项目', { builtin: true }), label('g-priority', '优先级')]
  value.orders.tagGroup.ids = [PROJECT_GROUP_ID, 'g-priority']
  value.tags = [label('t-p0', 'P0 紧急', { groupId: 'g-priority' }), label('t-p1', 'P1 常规', { groupId: 'g-priority' }), label('t-loose', '独立标签')]
  value.orders.tag.ids = ['t-p0', 't-p1', 't-loose']
  return value
}

test('every dimension the board can group by is listed in durable order', () => {
  const value = board()
  assert.deepEqual(dimensionOptions(value, t).map(option => option.key), [PROJECT_DIMENSION, STATUS_DIMENSION, 'g-priority', UNGROUPED_DIMENSION])
  assert.equal(dimensionName(value, 'g-priority', t), '优先级')
  assert.equal(dimensionName(value, 'missing', t), '项目总览', 'an unknown dimension falls back to the project grid')
  value.tags = value.tags.filter(tag => tag.groupId === 'g-priority')
  assert.deepEqual(dimensionOptions(value, t).map(option => option.key), [PROJECT_DIMENSION, STATUS_DIMENSION, 'g-priority'], 'no ungrouped tags means no ungrouped dimension')
})

test('a tag-group dimension keeps only values with sessions and puts the unset remainder last', () => {
  const value = board()
  const cards = [card('a', { tagIds: ['t-p0'] }), card('b', { tagIds: ['t-loose'] }), card('c')]
  assert.deepEqual(dimensionBuckets(value, cards, 'g-priority', t).map(bucket => [bucket.key, bucket.cards.map(row => row.sessionId)]), [
    ['t-p0', ['a']],
    ['unset', ['b', 'c']],
  ], 'P1 has no session so it is not a card, and sessions without the group land in one unset card')
})

test('status and ungrouped dimensions bucket by their own values', () => {
  const value = board()
  const cards = [card('run'), card('done', { status: 'pending_confirm', placement: { kind: 'builtin', status: 'pending_confirm' } }), card('idle', { status: 'not_started', placement: { kind: 'unset' } }), card('tagged', { tagIds: ['t-loose'] })]
  assert.deepEqual(dimensionBuckets(value, cards, STATUS_DIMENSION, t).map(bucket => [bucket.key, bucket.cards.length]), [['in_progress', 2], ['pending_confirm', 1], ['unset', 1]], 'statuses keep the configured order and never lose the unset bucket')
  assert.deepEqual(dimensionBuckets(value, cards, UNGROUPED_DIMENSION, t).map(bucket => [bucket.key, bucket.cards.map(row => row.sessionId)]), [
    ['t-loose', ['tagged']],
    ['unset', ['run', 'done', 'idle']],
  ])
  assert.deepEqual(dimensionBuckets(value, cards, PROJECT_DIMENSION, t), [], 'the project dimension keeps its own grid')
})
