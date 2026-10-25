import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EMPTY } from '../lib/shared/model.js'
import { harness, observation, code, workflowBinding, replayFixture, stateTarget } from './helpers.mjs'

test('A01/A03 explicit add, duplicate preserves metadata and archive', async t => {
  const h = harness(t)
  assert.equal((await h.service.snapshot()).board.cards.length, 0)
  const p = await h.label('project', '自主项目')
  await h.add('session-a', 'completed', p.id)
  assert.equal(h.card('session-a').status, 'pending_confirm')
  await h.edit('session-a', { progress: '保留进展' }); await h.archive('session-a', true)
  await h.join('session-a')
  assert.equal(h.store.read().cards.length, 1)
  assert.equal(h.card('session-a').projectId, p.id)
  assert.equal(h.card('session-a').progress, '保留进展')
  assert.notEqual(h.card('session-a').archivedAt, null)
})

test('A05/A06/A19 normal finish pending, explicit review, new run reopens', async t => {
  const h = harness(t)
  await h.add('a', 'running')
  assert.equal(h.card('a').status, 'in_progress')
  h.host.set('a', observation()); await h.sync('a')
  assert.equal(h.card('a').reviewAt, 200)
  h.host.setSource('a', replayFixture('a', h.card('a').runtime))
  await assert.rejects(h.review('a', 'accept', { confirmed: false }), code('INVALID'))
  await h.review('a', 'accept')
  assert.equal(h.card('a').status, 'accepted')
  h.host.set('a', observation('running', 'turn:20', { cursor: 21, episodeOrder: 20 })); await h.sync('a')
  assert.equal(h.card('a').status, 'in_progress'); assert.equal(h.card('a').acceptedAt, null)
  h.host.set('a', observation('completed', 'turn:20', { cursor: 30, episodeOrder: 20, endedAt: 999 })); await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm'); assert.equal(h.card('a').reviewAt, 999)
})

test('A07/A21 same completed episode cannot undo accept/return/reopen even after refresh', async t => {
  const h = harness(t)
  for (const action of ['return', 'accept']) {
    const id = `a-${action}`
    await h.add(id)
    h.host.setSource(id, replayFixture(id, h.card(id).runtime))
    await h.review(id, action)
    h.host.set(id, observation()); await h.sync(id)
    assert.equal(h.card(id).status, action === 'accept' ? 'accepted' : 'in_progress')
    if (action === 'accept') { await h.review(id, 'reopen'); await h.sync(id); assert.equal(h.card(id).status, 'in_progress') }
  }
})

test('A20/A24 unknown, waiting, error and interruption never become accepted or pending', async t => {
  const h = harness(t)
  for (const phase of ['waiting_input', 'waiting_approval', 'failed', 'interrupted', 'continuation_pending', 'suspended', 'unknown']) {
    const id = `id-${phase}`
    await h.add(id, phase)
    assert.equal(h.card(id).status, 'in_progress')
    h.host.setSource(id, replayFixture(id, h.card(id).runtime))
    await assert.rejects(h.review(id, 'accept'), code('REVIEW_STALE'))
  }
  await h.add('cold')
  h.host.set('cold', observation('completed', 'turn:0', { sourceLive: false })); await h.sync('cold')
  h.host.setSource('cold', replayFixture('cold', h.card('cold').runtime))
  await assert.rejects(h.review('cold', 'accept'), code('REVIEW_STALE'))
  h.host.set('cold', new Error('offline')); await h.sync('cold')
  assert.equal(h.card('cold').runtime.sync, 'unknown'); assert.equal(h.card('cold').status, 'pending_confirm')
  await assert.rejects(h.review('cold', 'accept'), /offline/)
})

test('A22 old confirmation rejected even if newer round already normally completed', async t => {
  const h = harness(t)
  await h.add('a')
  const previous = h.card('a')
  h.host.set('a', observation('completed', 'turn:20', { cursor: 30, episodeOrder: 20 }))
  await assert.rejects(h.mutate({ type: 'review', ...workflowBinding(previous), action: 'accept', confirmed: true, destination: { kind: 'stay' } }), code('REVIEW_STALE'))
  assert.equal(h.card('a').runtime.episodeId, 'turn:20'); assert.equal(h.card('a').status, 'pending_confirm')
})

test('A09/A23 archived cards track existing and later runs without restoring', async t => {
  const h = harness(t)
  const p = await h.label('project', '混合工作区')
  await h.add('a', 'running', p.id)
  await assert.rejects(h.archive('a', true, false), code('INVALID'))
  await h.archive('a', true)
  const archivedAt = h.card('a').archivedAt
  h.host.set('a', observation('completed')); await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm'); assert.equal(h.card('a').archivedAt, archivedAt)
  await h.archive('a', false)
  assert.equal(h.card('a').reviewAt, 200)
  assert.equal(h.card('a').projectId, p.id)
})

test('A10/A25/A33 metadata never affects runtime/activity unintentionally', async t => {
  const h = harness(t)
  const p = await h.label('project', '项目'), tag = await h.label('tag', 'UI')
  await h.add('a', 'completed')
  const before = h.card('a')
  await h.move('a', p.id, { kind: 'preserve' })
  await h.edit('a', { progress: '进展', tagIds: [tag.id], titleOverride: '标题' })
  const after = h.card('a')
  for (const field of ['runtime', 'status', 'reviewAt', 'activityAt']) assert.deepEqual(after[field], before[field])
  h.host.set('a', { ...observation(), workspace: '/a-totally-different-workspace' }); await h.sync('a')
  assert.equal(h.card('a').projectId, p.id)
  await h.move('a', null, { kind: 'preserve' }); assert.equal(h.card('a').projectId, null)
})

test('A14 separate metadata CAS permits independent host progress but rejects stale edits', async t => {
  const h = harness(t)
  await h.add('a', 'running')
  const revision = h.card('a').metadataRevision
  h.host.set('a', observation()); await h.sync('a')
  await h.edit('a', { progress: 'concurrent-safe' }, revision)
  assert.equal(h.card('a').status, 'pending_confirm')
  await assert.rejects(h.edit('a', { progress: 'overwrite' }, revision), code('CONFLICT'))
  assert.equal(h.card('a').progress, 'concurrent-safe')
})

test('A17 new membership never manufactures historical acceptance and retired confirmation fields are rejected', async t => {
  const h = harness(t)
  for (const [id, value] of [['old', observation('not_started')], ['known', observation()], ['unknown', observation('not_started', null, { sync: 'unknown', sourceLive: false })]]) {
    h.host.set(id, value, false)
    const { binding: inspection } = await h.inspect(id)
    await assert.rejects(h.mutate({ type: 'add_card', sessionId: id, projectId: null, inspection, confirmHistorical: true }))
    await h.join(id)
    assert.equal(h.card(id).decision, null); assert.equal(h.card(id).acceptedAt, null)
    assert.notEqual(h.card(id).status, 'accepted')
  }
})

test('A31/A32 labels keep unique normalized names in the tag namespace and deletion guards archived refs', async t => {
  const h = harness(t)
  const tag = await h.label('tag', '周末优先')
  // v10 stores a project as a tag value, so project and tag names share one namespace.
  await assert.rejects(h.label('project', '周末优先'), code('INVALID'))
  assert.equal((await h.label('project', '周末计划')).name, '周末计划')
  await assert.rejects(h.label('tag', ' 周末优先 '), code('INVALID'))
  await assert.rejects(h.label('project', ' 周末计划 '), code('INVALID'))
  await h.add('a', 'completed'); await h.edit('a', { tagIds: [tag.id] }); await h.archive('a', true)
  await assert.rejects(h.mutate({ type: 'delete_label', dimension: 'tag', id: tag.id, expectedRevision: tag.revision }), code('IN_USE'))
  await h.archive('a', false); await h.edit('a', { tagIds: [] })
  await h.mutate({ type: 'delete_label', dimension: 'tag', id: tag.id, expectedRevision: tag.revision })
  assert.equal(h.store.read().tags.length, 0)
  assert.equal(h.store.read().projects.length, 1, 'the project tag value remains a project')
})

test('one tag per group is the only shape a card can take', async t => {
  const h = harness(t)
  await h.mutate({ type: 'create_tag_group', name: '优先级', color: null })
  const group = h.store.read().tagGroups.find(row => row.name === '优先级')
  const high = await h.mutate({ type: 'create_label', dimension: 'tag', name: '高', color: null, groupId: group.id })
  const low = await h.mutate({ type: 'create_label', dimension: 'tag', name: '低', color: null, groupId: group.id })
  await h.add('a', 'completed')
  await assert.rejects(h.edit('a', { tagIds: [high.board.tags.find(row => row.name === '高').id, low.board.tags.find(row => row.name === '低').id] }), code('INVALID'), 'two values of one group are refused')
  const one = high.board.tags.find(row => row.name === '高').id
  await h.edit('a', { tagIds: [one] })
  assert.deepEqual(h.card('a').tagIds, [one], 'one value per group is accepted')
})

test('A25 deleting a project clears its grouping only; board-wide statuses survive', async t => {
  const h = harness(t)
  const p = await h.label('project', 'Doomed')
  const status = await h.label('status', 'Doing')
  await h.add('a', 'completed', p.id)
  h.host.set('b', observation('not_started'), false); await h.join('b', p.id)
  h.host.setSource('b', replayFixture('b', h.card('b').runtime))
  await h.mutate({ type: 'choose_state', ...workflowBinding(h.card('b')), selection: { kind: 'custom', target: stateTarget(status) } })
  assert.deepEqual(h.card('b').placement, { kind: 'custom', statusId: status.id })
  const project = h.store.read().projects.find(row => row.id === p.id)
  const order = h.store.read().orders.project
  await assert.rejects(h.mutate({ type: 'delete_project', projectId: p.id, expectedProjectRevision: project.revision + 1, confirmed: true }), code('CONFLICT'))
  await assert.rejects(h.mutate({ type: 'delete_project', projectId: p.id, expectedProjectRevision: project.revision }), 'deleting requires an explicit confirmation')
  await h.mutate({ type: 'delete_project', projectId: p.id, expectedProjectRevision: project.revision, confirmed: true })
  const board = h.store.read()
  assert.equal(board.projects.length, 0)
  assert.deepEqual(board.orders.project.ids, order.ids.filter(id => id !== p.id))
  assert.notEqual(board.orders.project.revision, order.revision)
  assert.equal(board.cards.length, 2)
  for (const id of ['a', 'b']) assert.equal(h.card(id).projectId, null, `${id} stays tracked as an unassigned session`)
  assert.deepEqual(h.card('b').placement, { kind: 'custom', statusId: status.id }, 'a board-wide status is not a project child')
  assert.deepEqual(board.statuses.map(row => row.id), [status.id])
  assert.equal(h.card('a').status, 'pending_confirm', 'host progress is independent of the deleted project')
  assert.equal(h.host.values.size, 2, 'the host chats are untouched')
})

test('A38/A39/A40/A41 ordering is exact one-list CAS and new values append before empty', async t => {
  const h = harness(t)
  const first = await h.label('project', 'One'), second = await h.label('project', 'Two')
  const initial = h.store.read().orders.project
  assert.deepEqual(initial.ids, [first.id, second.id, EMPTY])
  await h.mutate({ type: 'reorder', dimension: 'project', ids: [EMPTY, second.id, first.id], expectedRevision: initial.revision })
  const third = await h.label('project', 'Three')
  // The unassigned sentinel is a virtual bucket, not a tag: it sorts last no matter
  // what the caller sends, and new values append before it.
  assert.deepEqual(h.store.read().orders.project.ids, [second.id, first.id, third.id, EMPTY])
  await assert.rejects(h.mutate({ type: 'reorder', dimension: 'project', ids: initial.ids, expectedRevision: initial.revision }), code('CONFLICT'))
  const state = h.store.read().orders.status
  await h.mutate({ type: 'reorder', dimension: 'status', ids: ['pending_confirm', 'pending_review', 'accepted', 'in_progress'], expectedRevision: state.revision })
  await h.add('a'); h.host.setSource('a', replayFixture('a', h.card('a').runtime)); await h.review('a', 'accept'); assert.equal(h.card('a').status, 'accepted')
  await assert.rejects(h.mutate({ type: 'reorder', dimension: 'status', ids: ['accepted', 'accepted', 'in_progress'], expectedRevision: 1 }), code('INVALID'))
})

test('idempotency returns current snapshot without replaying a successful mutation', async t => {
  const h = harness(t), requestId = randomUUID()
  const command = { type: 'create_project', name: 'Only once', color: null, tagIds: [] }
  await h.mutate(command, requestId); await h.mutate(command, requestId)
  assert.equal(h.store.read().projects.length, 1)
  await assert.rejects(h.mutate({ ...command, name: 'different' }, requestId), code('CONFLICT'))
})

test('A24 stale source regression revokes freshness without reverting human result', async t => {
  const h = harness(t)
  await h.add('a'); h.host.setSource('a', replayFixture('a', h.card('a').runtime)); await h.review('a', 'accept')
  h.host.set('a', observation('running', 'turn:0', { cursor: 5 })); await h.sync('a')
  assert.equal(h.card('a').runtime.sync, 'unknown'); assert.equal(h.card('a').status, 'accepted')
})

test('strict input boundary rejects extra properties, invalid refs and confirmation bypasses', async t => {
  const h = harness(t)
  await assert.rejects(h.mutate({ type: 'create_project', name: 'ok', color: null, tagIds: [], status: 'accepted' }))
  h.host.set('a', observation(), false)
  const { binding: inspection } = await h.inspect('a')
  await assert.rejects(h.mutate({ type: 'add_card', sessionId: 'a', projectId: 'missing', inspection }), code('NOT_FOUND'))
  await h.add('b')
  await assert.rejects(h.review('b', 'accept'), code('REVIEW_STALE'), 'missing replay is not silently made complete by the fixture')
  h.host.setSource('b', replayFixture('b', h.card('b').runtime, { prefixDigests: [] }))
  await assert.rejects(h.review('b', 'accept'), code('REVIEW_STALE'), 'incomplete prefix coverage cannot authorize a review')
  assert.equal(h.card('b').decision, null)
  await assert.rejects(h.edit('b', { tagIds: ['untrusted'] }), code('INVALID'))
})

test('transcript preview is card-scoped, read-only and reports partial coverage', async t => {
  const h = harness(t)
  await h.add('a')
  h.host.transcripts.set('a', { messages: [{ id: 'u1', role: 'user', time: 10, parts: [{ type: 'text', text: 'hello' }] }, { id: 't1', role: 'tool', time: 20, parts: [{ type: 'tool-result', name: 'read', text: 'body', isError: false }] }], truncated: false })
  const value = await h.service.transcript({ sessionId: 'a' })
  assert.equal(value.title, 'Existing session')
  assert.equal(value.coverage, 'complete')
  assert.deepEqual(value.messages.map(message => message.role), ['user', 'tool'])
  h.host.transcripts.set('a', { messages: [], truncated: true })
  const partial = await h.service.transcript({ sessionId: 'a' })
  assert.equal(partial.coverage, 'partial')
  await assert.rejects(h.service.transcript({ sessionId: 'not-tracked' }), code('NOT_FOUND'))
  h.host.transcripts.set('a', new Error('host read failed'))
  await assert.rejects(h.service.transcript({ sessionId: 'a' }), code('UNAVAILABLE'))
})

test('A26 accepting directly from 待确认 is one atomic review with no half-applied confirm', async t => {
  const h = harness(t)
  const p = await h.label('project', 'Atomic acceptance'), next = await h.label('status', 'Next')
  await h.add('atomic', 'completed', p.id)
  h.host.setSource('atomic', replayFixture('atomic', h.card('atomic').runtime))
  const before = h.card('atomic')
  assert.equal(before.status, 'pending_confirm')
  const command = { type: 'review', ...workflowBinding(before), action: 'accept', confirmed: true, destination: { kind: 'custom', target: stateTarget(next) } }
  const snapshot = await h.mutate(command)
  const card = snapshot.board.cards[0]
  assert.equal(card.status, 'accepted')
  assert.deepEqual(card.placement, { kind: 'custom', statusId: next.id })
  assert.equal(card.reviewAt, null)
  assert.equal(h.store.history({ sessionId: 'atomic', membershipId: card.membershipId, limit: 100 }).records.filter(record => record.kind === 'state_changed').length, 0, 'the intermediate 待确认 -> 待验收 step is not committed separately')
  assert.equal(h.store.history({ sessionId: 'atomic', membershipId: card.membershipId, limit: 100 }).records.filter(record => record.kind === 'accepted').length, 1)
})

test('A27 a same-episode sync does not reject a work-state choice with benign lifecycle drift', async t => {
  const h = harness(t)
  const p = await h.label('project', 'State drift'), next = await h.label('status', 'Next')
  await h.add('drift', 'completed', p.id)
  h.host.setSource('drift', replayFixture('drift', h.card('drift').runtime))
  await h.review('drift', 'accept')
  const checked = h.card('drift')
  h.host.set('drift', observation('completed', checked.runtime.episodeId, { endedAt: 300 }))
  await h.sync('drift')
  const synced = h.card('drift')
  assert.equal(synced.status, 'accepted')
  assert(synced.lifecycleRevision > checked.lifecycleRevision, 'the same episode changed runtime facts')
  await h.mutate({ type: 'choose_state', ...workflowBinding(checked), selection: { kind: 'custom', target: stateTarget(next) } })
  assert.deepEqual(h.card('drift').placement, { kind: 'custom', statusId: next.id })
})

test('A28 an explicit source rebaseline repairs a persistent gap without touching the card', async t => {
  const h = harness(t)
  await h.add('rebaseline', 'completed')
  h.host.setSource('rebaseline', replayFixture('rebaseline', h.card('rebaseline').runtime))
  await h.sync('rebaseline')
  h.host.setSource('rebaseline', replayFixture('rebaseline', h.card('rebaseline').runtime, { sourceIdentity: 'incompatible-source' }))
  await h.sync('rebaseline')
  h.host.setSource('rebaseline', replayFixture('rebaseline', h.card('rebaseline').runtime))
  await h.sync('rebaseline')
  const before = h.card('rebaseline')
  await h.mutate({ type: 'rebaseline_source', sessionId: 'rebaseline', membershipId: before.membershipId, expectedMetadataRevision: before.metadataRevision, confirmed: true })
  assert.equal(h.card('rebaseline').status, before.status)
  await h.review('rebaseline', 'accept')
  assert.equal(h.card('rebaseline').status, 'accepted')
})

test('A29 a pre-normalization source identity migrates without freezing review', async t => {
  const h = harness(t)
  await h.add('legacy-source', 'completed')
  const source = identity => ({ ...replayFixture('legacy-source', h.card('legacy-source').runtime, { sourceIdentity: identity }), legacySourceIdentity: 'legacy-identity' })
  h.host.setSource('legacy-source', source('legacy-identity'))
  await h.sync('legacy-source')
  const before = h.card('legacy-source')
  h.host.setSource('legacy-source', source('normalized-identity'))
  await h.sync('legacy-source')
  const migrated = h.card('legacy-source')
  assert.equal(migrated.status, before.status)
  await h.review('legacy-source', 'accept')
  assert.equal(h.card('legacy-source').status, 'accepted')
})
