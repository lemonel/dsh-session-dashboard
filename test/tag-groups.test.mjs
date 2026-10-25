import test from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_GROUP_ID } from '../lib/shared/model.js'
import { code, harness } from './helpers.mjs'

test('C11 tag groups scope one enumeration and reject duplicate names', async t => {
  const h = harness(t)
  const created = await h.mutate({ type: 'create_tag_group', name: '模块', color: null })
  // v10 keeps the builtin project group, so the custom group is not the first row.
  assert.equal(created.board.tagGroups.find(row => row.id === PROJECT_GROUP_ID)?.builtin, true)
  const group = created.board.tagGroups.find(row => row.name === '模块')
  assert.equal(group.builtin, false)
  assert.equal(group.revision, 0)
  await assert.rejects(h.mutate({ type: 'create_tag_group', name: '模块', color: null }), code('INVALID'))
  const tag = (await h.mutate({ type: 'create_label', dimension: 'tag', name: '前端', color: null, groupId: group.id })).board.tags.find(row => row.name === '前端')
  assert.equal(tag.groupId, group.id)
  assert.equal(tag.revision, 0)
})

test('C12 tag group edits are revision-fenced and only empty custom groups disappear', async t => {
  const h = harness(t)
  const group = (await h.mutate({ type: 'create_tag_group', name: '模块', color: null })).board.tagGroups.find(row => row.name === '模块')
  const renamed = await h.mutate({ type: 'update_tag_group', groupId: group.id, expectedRevision: 0, name: '领域', color: '#123456' })
  assert.equal(renamed.board.tagGroups.find(row => row.id === group.id).name, '领域')
  assert.equal(renamed.board.tagGroups.find(row => row.id === group.id).revision, 1)
  await assert.rejects(h.mutate({ type: 'update_tag_group', groupId: group.id, expectedRevision: 0, name: '其它', color: null }), code('CONFLICT'))
  const tag = (await h.mutate({ type: 'create_label', dimension: 'tag', name: '前端', color: null, groupId: group.id })).board.tags.find(row => row.name === '前端')
  await assert.rejects(h.mutate({ type: 'delete_tag_group', groupId: group.id, expectedRevision: 1 }), code('IN_USE'))
  const moved = await h.mutate({ type: 'update_label', dimension: 'tag', id: tag.id, expectedRevision: 0, name: '前端', color: null, groupId: null })
  assert.equal(moved.board.tags.find(row => row.id === tag.id).groupId, null)
  await h.mutate({ type: 'delete_tag_group', groupId: group.id, expectedRevision: 1 })
  // Only the empty custom group disappears; the builtin project group stays.
  assert.deepEqual(h.store.read().tagGroups.map(row => row.id), [PROJECT_GROUP_ID])
})

test('C13 a builtin tag group locks identity and existing values but accepts extensions', async t => {
  const h = harness(t)
  h.store.commit(null, board => {
    board.tagGroups = [
      { id: PROJECT_GROUP_ID, name: '项目', color: null, builtin: true, revision: 0 },
      { id: 'group-status', name: '状态', color: null, builtin: true, revision: 0 },
    ]
    board.tags = [{ id: 'tag-fixed', name: '进行中', color: null, createdAt: 1, revision: 0, groupId: 'group-status' }]
    board.orders.tag = { dimension: 'tag', ids: ['tag-fixed'], revision: 1 }
    return true
  })
  // Extension is allowed: the enumeration may grow.
  const extended = await h.mutate({ type: 'create_label', dimension: 'tag', name: '新增值', color: null, groupId: 'group-status' })
  assert.equal(extended.board.tags.find(row => row.name === '新增值').groupId, 'group-status')
  // Identity and existing values are not.
  await assert.rejects(h.mutate({ type: 'update_tag_group', groupId: 'group-status', expectedRevision: 0, name: '改名', color: null }), code('FORBIDDEN'))
  await assert.rejects(h.mutate({ type: 'delete_tag_group', groupId: 'group-status', expectedRevision: 0 }), code('FORBIDDEN'))
  await assert.rejects(h.mutate({ type: 'update_label', dimension: 'tag', id: 'tag-fixed', expectedRevision: 0, name: '改名', color: null }), code('FORBIDDEN'))
  await assert.rejects(h.mutate({ type: 'delete_label', dimension: 'tag', id: 'tag-fixed', expectedRevision: 0 }), code('FORBIDDEN'))
  // Moving an existing tag into the system enumeration is not an extension.
  await assert.rejects(h.mutate({ type: 'update_label', dimension: 'tag', id: extended.board.tags.find(row => row.name === '新增值').id, expectedRevision: 0, name: '新增值', color: null, groupId: null }), code('FORBIDDEN'))
})

test('C14 deleting a tag is refused while a card or project still references it', async t => {
  const h = harness(t)
  const tag = await h.label('tag', '共享标签')
  const project = await h.label('project', '项目')
  await h.add('a', 'completed', project.id)
  await h.edit('a', { tagIds: [tag.id] })
  await assert.rejects(h.mutate({ type: 'delete_label', dimension: 'tag', id: tag.id, expectedRevision: 0 }), code('IN_USE'))
  await h.edit('a', { tagIds: [] })
  await h.mutate({ type: 'delete_label', dimension: 'tag', id: tag.id, expectedRevision: 0 })
  assert.equal(h.store.read().tags.length, 0)
  assert.equal(h.store.read().orders.tag.ids.length, 0)
})
