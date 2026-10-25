import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { DashboardService } from '../lib/backend/service.js'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { randomUUID } from 'node:crypto'
import { workflowBinding, mutationFor } from './helpers.mjs'
import { denyNetwork, executionWorkspace, prompt, textResponse, userMessage } from './tools/execution-host.mjs'

// The installed AgentLoop owns Inbox mutations, pending lists, turn boundaries and
// durable JSONL. Parked input is real input, not a fabricated running status.
test('parked real Inbox input cannot masquerade as a reliable never-executed session', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('parked-initial')
  await h.add(agent.id)
  assert.equal((await h.card(agent.id)).runtime.phase, 'not_started')
  const observer = createDshHost(h.ctx)
  t.after(() => observer.close())
  const before = await observer.capture(agent.id)
  assert.equal(before.validate(), true)
  agent.inject(userMessage('Parked context without waking the driver'))
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(before.validate(), false, 'the exact cut is invalidated by parked input despite idle status')
  before.dispose()
  const current = (await h.sync(agent.id)).board.cards[0]
  assert.equal(current.runtime.sync, 'unknown')
  assert.equal(current.runtime.episodeId, null)
  assert.match(current.runtime.explanation, /待处理输入/)
  assert.equal(h.adapter.requests.length, 0, 'dashboard reads never drain or start parked input')
  agent.inbox.clear()
  const cleared = (await h.sync(agent.id)).board.cards[0]
  assert.equal(cleared.runtime.sync, 'synced')
  assert.equal(cleared.runtime.phase, 'not_started')
  assert.equal(h.adapter.requests.length, 0)
})

test('real parked input revokes terminal review authority without erasing the completed result', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('parked-terminal')
  h.adapter.enqueue(textResponse('A whole actual completed turn'))
  prompt(agent); await agent.whenIdle(); await h.add(agent.id)
  const pending = await h.card(agent.id)
  assert.equal(pending.status, 'pending_confirm')
  agent.inject(userMessage('Pending next-step input after normal completion'))
  const blocked = (await h.sync(agent.id)).board.cards[0]
  assert.equal(blocked.runtime.sync, 'unknown')
  assert.equal(blocked.runtime.episodeId, pending.runtime.episodeId)
  assert.equal(blocked.status, 'pending_confirm')
  assert.equal(blocked.reviewAt, pending.reviewAt)
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error' && error.details.reason === 'REVIEW_STALE')
  agent.inbox.clear()
  const accepted = (await h.review(agent.id)).board.cards[0]
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.decision.episodeId, pending.runtime.episodeId)
  assert.equal(h.adapter.requests.length, 1)
})

test('real Inbox insertion at the final transaction fence rolls back a human decision and receipt', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('parked-final-fence')
  h.adapter.enqueue(textResponse('Output before the final fence'))
  prompt(agent); await agent.whenIdle()
  const store = new SqliteBoardStore(':memory:'), host = createDshHost(h.ctx)
  const service = new DashboardService(store, host)
  t.after(() => service.close())
  const { binding: inspection } = await service.inspectSession({ sessionId: agent.id })
  await service.mutate(mutationFor(service, { type: 'add_card', sessionId: agent.id, projectId: null, inspection }))
  const checked = store.read().cards[0], requestId = randomUUID()
  await service.mutate(mutationFor(service, { type: 'confirm_review', ...workflowBinding(checked) }))
  const command = { type: 'review', ...workflowBinding(store.read().cards[0]), action: 'accept', confirmed: true, destination: { kind: 'stay' } }
  const commit = store.commit.bind(store)
  let inserted = false
  store.commit = (receipt, change, fence, sources) => {
    let calls = 0
    return commit(receipt, change, () => {
      if (receipt && ++calls === 2 && !inserted) {
        inserted = true
        agent.inject(userMessage('New parked input after the decision callback but before COMMIT'))
      }
      fence?.()
    }, sources)
  }
  await assert.rejects(service.mutate(mutationFor(service, command, requestId)), error => error.code === 'REVIEW_STALE')
  assert.equal(inserted, true)
  const after = store.read().cards[0]
  assert.equal(after.status, 'pending_review')
  assert.equal(after.decision, null)
  assert.equal(after.acceptedAt, null)
  agent.inbox.clear()
  const retry = await service.mutate(mutationFor(service, command, requestId))
  assert.equal(retry.board.cards[0].status, 'accepted', 'failed final fence did not leave an idempotency receipt')
  assert.equal(h.adapter.requests.length, 1)
})
