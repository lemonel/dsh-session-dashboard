import test from 'node:test'
import assert from 'node:assert/strict'
import { runningAgentsUnder } from '../lib/backend/dsh-host.js'
import { attentionKind, childAgentsRunning, runtimeText } from '../lib/frontend/view-model.js'
import { unknownRuntime } from '../lib/shared/model.js'
import { harness, observation } from './helpers.mjs'

const agent = (id, status) => ({ id, status, session: { id } })
const registry = (agents, ownership) => ({
  list: () => agents,
  isOwnedBy: (id, owner) => ownership.some(([child, parent]) => child === id && parent === owner.id),
})

test('A16 running agents count child agents only, never the root', () => {
  const root = agent('a', 'running'), child = agent('a:1', 'idle'), grandchild = agent('a:1:1', 'running')
  const other = agent('b', 'running'), stranger = agent('x', 'running')
  const owned = [['a:1', 'a'], ['a:1:1', 'a:1'], ['b:1', 'b'], ['b:2', 'b']]
  const b1 = agent('b:1', 'running'), b2 = agent('b:2', 'running')
  const under = runningAgentsUnder(registry([root, child, grandchild, other, stranger, b1, b2], owned), root)
  assert.equal(under, 1, 'only the transitive grandchild counts; the root and idle child do not')
  assert.equal(runningAgentsUnder(registry([root, child, grandchild, other, stranger, b1, b2], owned), other), 2, 'another tree counts its own children only')
  assert.equal(runningAgentsUnder(registry([agent('c', 'idle')], []), agent('c', 'idle')), 0)
})

test('A16b the badge is about extra agents: a running root alone counts zero', () => {
  const root = agent('a', 'running'), first = agent('a:1', 'running'), second = agent('a:2', 'running')
  assert.equal(runningAgentsUnder(registry([root], []), root), 0, 'a plain running session has no child agents')
  assert.equal(runningAgentsUnder(registry([root, first, second], [['a:1', 'a'], ['a:2', 'a']]), root), 2)
})

function card(extra = {}) {
  return {
    sessionId: 'a', membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null },
    hostTitle: 'A', titleOverride: null, workspace: '/w', projectId: 'p', tagIds: [], progress: '',
    status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null,
    workflowRevision: 1, decision: null, joinedAt: 1, activityAt: 2, updatedAt: 2, reviewAt: null, acceptedAt: null,
    archivedAt: null, metadataRevision: 1, lifecycleRevision: 1,
    runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'suspended', attention: 'resume', episodeId: 'turn:1', episodeOrder: 1, activeAgents: 2 },
    ...extra,
  }
}

test('A17 a parked round with running child agents reads as running and needs no action', () => {
  const t = key => key
  const parked = card()
  assert.equal(childAgentsRunning(parked), true)
  assert.equal(runtimeText(parked, t), 'running')
  assert.equal(attentionKind(parked), 'none', 'child agents are working, not waiting on the user')
  const idle = card({ runtime: { ...parked.runtime, activeAgents: 0 } })
  assert.equal(childAgentsRunning(idle), false)
  assert.equal(runtimeText(idle, t), 'needsResume')
  assert.equal(attentionKind(idle), 'resume')
  const pending = card({ runtime: { ...parked.runtime, phase: 'continuation_pending', activeAgents: 1 } })
  assert.equal(runtimeText(pending, t), 'running')
  const really = card({ runtime: { ...parked.runtime, phase: 'running', attention: 'none' } })
  assert.equal(runtimeText(really, t), 'running')
  // Main turn ended, children still working: still reads as running, not completed.
  const doneWithChildren = card({ runtime: { ...parked.runtime, phase: 'completed', attention: 'none', endedAt: 2, activeAgents: 2 } })
  assert.equal(childAgentsRunning(doneWithChildren), true)
  assert.equal(runtimeText(doneWithChildren, t), 'running')
  assert.equal(attentionKind(doneWithChildren), 'none', 'the finished-looking round is still working, not waiting on the user')
})

test('A18 a completed turn waits for running child agents before 待确认', async t => {
  const h = harness(t)
  h.host.set('a', observation('completed', 'turn:0', { activeAgents: 2 }), false)
  await h.join('a')
  const pending = h.card('a')
  assert.equal(pending.runtime.phase, 'completed')
  assert.equal(pending.status, 'in_progress', 'child agents still run, so the round is not settled')
  assert.equal(pending.reviewAt, null)
  assert.equal(pending.placement.kind, 'builtin')
  assert.equal(pending.placement.status, 'in_progress')

  // A card that already reached 待确认 returns to in progress when children appear.
  h.host.set('a', observation('completed', 'turn:0', { activeAgents: 0 }), false)
  await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm')
  assert.equal(h.card('a').reviewAt, 200)
  h.host.set('a', observation('completed', 'turn:0', { activeAgents: 3 }), false)
  await h.sync('a')
  assert.equal(h.card('a').status, 'in_progress', 'a running child reopens the unsettled round')
  assert.equal(h.card('a').reviewAt, null)

  // Once the children finish, the normal confirmation step applies.
  h.host.set('a', observation('completed', 'turn:0', { activeAgents: 0 }), false)
  await h.sync('a')
  assert.equal(h.card('a').status, 'pending_confirm')
  assert.equal(h.card('a').reviewAt, 200)
  assert.equal(h.store.read().cards[0].status, 'pending_confirm', 'invariants accept the settled card')
})
