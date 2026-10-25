import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, observation, code, replayFixture } from './helpers.mjs'

test('A21 delayed same-episode start/wait cannot erase terminal human decision', async t => {
  const h = harness(t)
  for (const action of ['accept', 'return']) {
    const id = `session-${action}`
    await h.add(id); h.host.setSource(id, replayFixture(id, h.card(id).runtime)); await h.review(id, action)
    const before = h.card(id)
    for (const cursor of [10, 11]) {
      h.host.set(id, observation('waiting_input', 'turn:0', { cursor })); await h.sync(id)
      const after = h.card(id)
      assert.equal(after.status, before.status)
      assert.deepEqual(after.decision, before.decision)
      assert.equal(after.acceptedAt, before.acceptedAt)
      assert.equal(after.runtime.sync, 'unknown')
      h.host.set(id, observation('completed', 'turn:0', { cursor: 12 })); await h.sync(id)
      assert.equal(h.card(id).status, before.status)
    }
  }
})

test('title-only journal advances do not invalidate a checked terminal episode', async t => {
  const h = harness(t)
  await h.add('a')
  const before = h.card('a')
  h.host.set('a', { ...observation('completed', 'turn:0', { cursor: 11 }), title: 'renamed' }); await h.sync('a')
  const after = h.card('a')
  assert.equal(after.runtime.cursor, 11); assert.equal(after.hostTitle, 'renamed')
  assert.equal(after.lifecycleRevision, before.lifecycleRevision)
  h.host.setSource('a', replayFixture('a', h.card('a').runtime))
  await h.confirm('a')
  await h.review('a', 'accept', { expectedLifecycleRevision: h.card('a').lifecycleRevision })
  assert.equal(h.card('a').status, 'accepted')
})

test('newer durable episode still reopens a settled accepted result', async t => {
  const h = harness(t)
  await h.add('a'); h.host.setSource('a', replayFixture('a', h.card('a').runtime)); await h.review('a', 'accept')
  h.host.set('a', observation('running', 'turn:20', { cursor: 21, episodeOrder: 20 })); await h.sync('a')
  assert.equal(h.card('a').status, 'in_progress'); assert.equal(h.card('a').decision, null)
})

test('resync of missing source preserves last decision but never authorizes review', async t => {
  const h = harness(t)
  await h.add('a')
  h.host.set('a', observation('completed', 'turn:0', { sync: 'missing', sourceLive: false, explanation: 'Unavailable session' })); await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm'); assert.equal(h.card('a').runtime.sync, 'missing')
  await assert.rejects(h.review('a', 'accept'), code('REVIEW_STALE'))
})

test('same terminal metadata observations keep pending, accepted, returned and reopened decisions and times stable', async t => {
  const h = harness(t)
  for (const disposition of ['pending', 'accepted', 'returned', 'reopened']) {
    const id = `metadata-${disposition}`
    await h.add(id)
    h.host.setSource(id, replayFixture(id, h.card(id).runtime))
    if (disposition === 'accepted' || disposition === 'reopened') await h.review(id, 'accept')
    if (disposition === 'returned') await h.review(id, 'return')
    if (disposition === 'reopened') await h.review(id, 'reopen')
    const before = h.card(id)
    for (const cursor of [11, 12, 13]) {
      h.host.set(id, observation('completed', 'turn:0', { cursor })); await h.sync(id)
      const after = h.card(id)
      assert.equal(after.runtime.cursor, cursor); assert.equal(after.lifecycleRevision, before.lifecycleRevision)
      assert.equal(after.reviewAt, before.reviewAt); assert.equal(after.acceptedAt, before.acceptedAt)
      assert.equal(after.status, before.status); assert.deepEqual(after.decision, before.decision)
    }
  }
})

test('Goal metadata fix does not exempt a regressing cursor or unknown durable tail from review fencing', async t => {
  const h = harness(t)
  await h.add('a')
  const checked = h.card('a')
  h.host.set('a', observation('completed', 'turn:0', { cursor: 9 })); await h.sync('a')
  assert.equal(h.card('a').runtime.sync, 'unknown'); assert.equal(h.card('a').runtime.cursor, checked.runtime.cursor)
  assert.match(h.card('a').runtime.explanation, /早于已确认/)
  await assert.rejects(h.review('a', 'accept', { expectedLifecycleRevision: checked.lifecycleRevision }), code('REVIEW_STALE'))
  h.host.set('a', observation('completed', 'turn:0', { cursor: 12, sync: 'unknown', explanation: '持久化tail与当前日志不一致' })); await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm'); assert.equal(h.card('a').runtime.sourceLive, false)
  assert.equal(h.card('a').reviewAt, checked.reviewAt); assert.match(h.card('a').runtime.explanation, /tail/)
  await assert.rejects(h.review('a', 'accept'), code('REVIEW_STALE'))
  h.host.set('a', observation('completed', 'turn:0', { cursor: 12 })); await h.sync('a')
  assert.equal(h.card('a').runtime.sync, 'synced'); assert.equal(h.card('a').reviewAt, checked.reviewAt)
})

test('actual cancelled newer episode clears old pending/accepted disposition and remains in progress even when archived', async t => {
  const h = harness(t)
  for (const accept of [false, true]) {
    const id = `actual-cancel-${accept}`
    await h.add(id); h.host.setSource(id, replayFixture(id, h.card(id).runtime)); if (accept) await h.review(id, 'accept')
    await h.archive(id, true)
    const before = h.card(id)
    h.host.set(id, observation('interrupted', 'turn:20', { cursor: 24, episodeOrder: 20, explanation: '用户停止了真实新执行' })); await h.sync(id)
    const after = h.card(id)
    assert.equal(after.status, 'in_progress'); assert.equal(after.runtime.phase, 'interrupted')
    assert.equal(after.decision, null); assert.equal(after.reviewAt, null); assert.equal(after.acceptedAt, null)
    assert.equal(after.archivedAt, before.archivedAt); assert(after.lifecycleRevision > before.lifecycleRevision)
    await assert.rejects(h.review(id, 'accept'), code('INVALID'))
  }
})
