import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowBinding } from './helpers.mjs'
import { TYPERT as GOAL_TYPERT } from '@deepseek-ai/dsh-goal/typert'
import { createDshHost } from '../lib/backend/dsh-host.js'
import {
  assertLocalSdk, assertPending, assertRunning, denyNetwork, eventsOf,
  executionWorkspace, latch, prompt, textResponse, toolResponse,
} from './tools/execution-host.mjs'

// Production AgentLoop, GoalService, Gateway, Loader, SQLite and JSONL own every
// lifecycle fact here. Only deterministic model chunks and registered tools are
// seams; no handwritten turn events, fake Agent, profile, network or global SDK.
const stale = error => error.code === 'dashboard/error' && error.details.reason === 'REVIEW_STALE'
const ref = goal => ({ id: goal.id, revision: goal.revision })
function goalGateway(h, agent) {
  h.ctx.typert.register(GOAL_TYPERT)
  return (method, args = {}) => h.ctx.typertGateway.invoke({ namespace: 'goals', method, args: { agentId: agent.id, ...args }, peer: h.peer })
}
async function completedGoal(workspace, id) {
  const h = await workspace.start({ goals: true })
  h.registerTool('finish_goal', async (_args, exec) => {
    const goal = h.ctx.goals.create(exec.agent, { objective: 'Verify durable Goal lifecycle boundaries', maxGoalRounds: 3 })
    h.ctx.goals.complete(exec.agent, ref(goal))
    return 'Goal completed inside this actual tool'
  })
  h.adapter.enqueue(toolResponse('finish_goal'), textResponse('Actual final output'))
  const agent = await h.create(id)
  await h.add(id); prompt(agent); await agent.whenIdle()
  const card = (await h.sync(id)).board.cards.find(value => value.sessionId === id)
  assertPending(card)
  // The user has looked at the finished round, so it is already 待验收.
  await h.sync(id)
  await h.confirm(id)
  assert.equal((await h.card(id)).status, 'pending_review')
  return { h, agent, card: await h.card(id), invoke: goalGateway(h, agent) }
}
function sameResult(after, before, exactRevision = true) {
  assert.equal(after.runtime.sync, 'synced', after.runtime.explanation ?? 'same durable result must stay fresh')
  assert.equal(after.runtime.phase, 'completed')
  assert.equal(after.runtime.sourceLive, true)
  assert.equal(after.runtime.episodeId, before.runtime.episodeId)
  assert.equal(after.runtime.episodeOrder, before.runtime.episodeOrder)
  assert.equal(after.runtime.startedAt, before.runtime.startedAt)
  assert.equal(after.runtime.endedAt, before.runtime.endedAt)
  assert.equal(after.runtime.fingerprint, before.runtime.fingerprint)
  if (exactRevision) assert.equal(after.lifecycleRevision, before.lifecycleRevision)
  assert.equal(after.reviewAt, before.reviewAt)
  assert.equal(after.acceptedAt, before.acceptedAt)
  assert.equal(after.status, before.status)
  assert.deepEqual(after.decision, before.decision)
}

test('D01/D02 actual Gateway edit/clear preserve pending and all human dispositions, cursor freshness, and JSONL restart', { timeout: 30000 }, async t => {
  denyNetwork(t)
  await assertLocalSdk()
  const workspace = await executionWorkspace(t)
  for (const disposition of ['pending', 'accepted', 'returned', 'reopened']) {
    const { h, agent, invoke } = await completedGoal(workspace, `goal-${disposition}`)
    if (disposition === 'accepted' || disposition === 'reopened') await h.review(agent.id)
    if (disposition === 'returned') await h.review(agent.id, 'return')
    if (disposition === 'reopened') await h.review(agent.id, 'reopen')
    const before = await h.card(agent.id)
    const checked = { type: 'review', ...workflowBinding(before), action: 'accept', confirmed: true, destination: { kind: 'stay' } }
    const originalEvents = await h.readEvents(agent.id)
    // The built host adapter's exact lease must invalidate on metadata too. Stable
    // semantic review identity does not let a previously retained cursor authorize COMMIT.
    const observer = createDshHost(h.ctx)
    try {
      const retained = await observer.capture(agent.id)
      await invoke('edit', { ref: ref(h.ctx.goals.get(agent)), request: { objective: 'Only edit already completed Goal metadata', maxGoalRounds: 4 } })
      assert.equal(retained.validate(), false, 'Goal edit invalidates the exact host cursor lease')
      retained.dispose()
    } finally { observer.close() }
    let after = (await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    sameResult(after, before)
    assert(after.runtime.cursor > before.runtime.cursor)
    await invoke('clear', { ref: ref(h.ctx.goals.get(agent)) })
    assert.equal(h.ctx.goals.get(agent), undefined)
    for (let index = 0; index < 2; index++) {
      after = (await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
      sameResult(after, before)
    }
    agent.cancel({ kind: 'user' })
    sameResult((await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id), before)
    const events = await h.readEvents(agent.id)
    assert.equal(eventsOf(events, 'turn/start').length, eventsOf(originalEvents, 'turn/start').length)
    assert.equal(eventsOf(events, 'turn/end').length, eventsOf(originalEvents, 'turn/end').length)
    assert.deepEqual(eventsOf(events, 'goal/change').slice(-2).map(event => event.data.operation), ['edit', 'clear'])
    await h.close()

    const restarted = await workspace.start({ goals: true })
    const cold = (await restarted.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    assert.equal(cold.status, before.status); assert.equal(cold.runtime.sourceLive, false)
    assert.equal(cold.runtime.endedAt, before.runtime.endedAt); assert.equal(cold.reviewAt, before.reviewAt)
    assert.deepEqual(cold.decision, before.decision)
    await assert.rejects(restarted.mutate(checked), stale, 'cold history never becomes human-review authority')
    await restarted.create(agent.id, true)
    const live = (await restarted.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    assert.equal(live.runtime.sync, 'synced'); assert.equal(live.runtime.sourceLive, true)
    assert.equal(live.status, before.status); assert.equal(live.runtime.endedAt, before.runtime.endedAt)
    assert.equal(live.reviewAt, before.reviewAt); assert.equal(live.acceptedAt, before.acceptedAt)
    assert.deepEqual(live.decision, before.decision)
    assert.equal(restarted.adapter.requests.length, 0, 'restart/reattachment never starts new model work')
    if (disposition === 'pending') {
      assert.equal(live.status, 'pending_review')
      await restarted.review(agent.id)
      assert.equal((await restarted.card(agent.id)).status, 'accepted', 'D01 clears recoverable review after actual live reattachment')
    }
    await restarted.close()
  }
})

test('completed Goal metadata editing keeps an already checked pending review binding usable via a fresh exact capture', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), { h, agent, card, invoke } = await completedGoal(workspace, 'checked-edit')
  const checked = { type: 'review', ...workflowBinding(card), action: 'accept', confirmed: true, destination: { kind: 'stay' } }
  await invoke('edit', { ref: ref(h.ctx.goals.get(agent)), request: { objective: 'Definition only; same completed output' } })
  await invoke('clear', { ref: ref(h.ctx.goals.get(agent)) })
  assert.equal((await h.mutate(checked)).board.cards[0].status, 'accepted')
  const accepted = await h.card(agent.id)
  await h.mutate({ type: 'remove_card', sessionId: agent.id, membershipId: accepted.membershipId, expectedMetadataRevision: accepted.metadataRevision, confirmed: true })
  await h.add(agent.id)
  const readded = await h.card(agent.id)
  assertPending(readded)
  assert.equal(readded.runtime.endedAt, card.runtime.endedAt)
  assert(readded.lifecycleRevision > accepted.lifecycleRevision, 'remove/re-add receives a new CAS generation')
  await assert.rejects(h.mutate(checked), error => error.code === 'dashboard/error' && error.details.reason === 'CONFLICT', 'old membership cannot cross remove/re-add even for the same durable episode')
})

test('unfinished Goal clear during a running tool keeps remaining real steps cancelled logically, while a later actual prompt can finish', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true })
  const entered = latch(), release = latch(), finalEntered = latch(), finalRelease = latch()
  h.registerTool('unfinished_goal', async (_args, exec) => {
    h.ctx.goals.create(exec.agent, { objective: 'Do not mistake clear for completion' })
    entered.release(); await release.wait(exec.signal)
    return 'Tool still returned after clear'
  })
  h.adapter.enqueue(toolResponse('unfinished_goal'), async function* (request) {
    finalEntered.release(); await finalRelease.wait(request.signal); yield* textResponse('Remainder of the cleared Goal turn')
  })
  const agent = await h.create('active-clear')
  await h.add(agent.id); prompt(agent); await entered.promise
  const running = (await h.sync(agent.id)).board.cards[0], invoke = goalGateway(h, agent)
  await invoke('clear', { ref: ref(h.ctx.goals.get(agent)) })
  assertRunning((await h.sync(agent.id)).board.cards[0])
  release.release(); await finalEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  finalRelease.release(); await agent.whenIdle()
  const cleared = (await h.sync(agent.id)).board.cards[0]
  assertRunning(cleared, 'suspended'); assert.equal(cleared.runtime.episodeId, running.runtime.episodeId)
  assert.match(cleared.runtime.explanation, /未完成目标已清除/)
  const events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'tool/result').length, 1); assert.equal(eventsOf(events, 'step/end').length, 2)
  assert.equal(eventsOf(events, 'turn/end').at(-1).data.reason.kind, 'completed', 'actual turn can end normally while its Goal was abandoned')
  await assert.rejects(h.review(agent.id), stale)
  await h.close()
  const restarted = await workspace.start({ goals: true })
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  const resumed = await restarted.create(agent.id, true)
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  assert.equal(restarted.adapter.requests.length, 0)
  restarted.adapter.enqueue(textResponse('Actually new independent work'))
  prompt(resumed, 'Start a real new task after clearing the old Goal'); await resumed.whenIdle()
  const next = (await restarted.sync(agent.id)).board.cards[0]
  assertPending(next); assert(next.runtime.episodeOrder > cleared.runtime.episodeOrder)
})

test('complete then clear inside the actual final tool waits for full normal end and never hides a real abort', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t)
  for (const stop of [false, true]) {
    const h = await workspace.start({ goals: true }), entered = latch(), release = latch()
    h.registerTool('complete_clear', async (_args, exec) => {
      const active = h.ctx.goals.create(exec.agent, { objective: 'Complete and remove metadata in one actual tool' })
      const complete = h.ctx.goals.complete(exec.agent, ref(active))
      h.ctx.goals.clear(exec.agent, ref(complete))
      entered.release(); await release.wait(exec.signal)
      return 'Completed Goal metadata is already cleared'
    })
    h.adapter.enqueue(toolResponse('complete_clear'))
    if (!stop) h.adapter.enqueue(textResponse('Final real response'))
    const agent = await h.create(`inside-clear-${stop}`)
    await h.add(agent.id); prompt(agent); await entered.promise
    assertRunning((await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id))
    if (stop) agent.cancel({ kind: 'user' })
    else release.release()
    await agent.whenIdle()
    const current = (await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    if (stop) { assertRunning(current, 'interrupted'); assert.match(current.runtime.explanation, /用户已停止/) }
    else assertPending(current)
    assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/end').at(-1).data.reason.kind, stop ? 'aborted' : 'completed')
    await h.close()
  }
})

test('agent-owned pause does not abort the current turn; resume/edit/complete with no new work cannot borrow its end', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true, automaticGoals: true })
  h.registerTool('pause_own_goal', async (_args, exec) => {
    const goal = h.ctx.goals.create(exec.agent, { objective: 'Agent requests a deliberate pause' })
    h.ctx.goals.pause(exec.agent, ref(goal))
    return 'Self-pause disarmed but did not cancel this actual turn'
  })
  h.adapter.enqueue(toolResponse('pause_own_goal'), textResponse('Paused normally'))
  const agent = await h.create('own-pause')
  await h.add(agent.id); prompt(agent); await agent.whenIdle()
  const paused = (await h.sync(agent.id)).board.cards[0]
  assertRunning(paused, 'suspended'); assert.match(paused.runtime.explanation, /暂停/)
  assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/end').at(-1).data.reason.kind, 'completed')
  // Hold the round-driver's official checkpoint, not a fabricated lifecycle boundary.
  const checkpoint = latch(), continueCheckpoint = latch()
  let held = false
  h.on('session/flush', async session => {
    if (session !== agent.session || held || h.ctx.goals.get(agent)?.phase !== 'active') return
    held = true; checkpoint.release(); await continueCheckpoint.promise
  })
  const invoke = goalGateway(h, agent)
  await invoke('resume', { ref: ref(h.ctx.goals.get(agent)) }); await checkpoint.promise
  const resumed = (await h.sync(agent.id)).board.cards[0]
  assertRunning(resumed, 'continuation_pending'); assert(resumed.runtime.episodeOrder > paused.runtime.episodeOrder)
  await invoke('edit', { ref: ref(h.ctx.goals.get(agent)), request: { objective: 'Resumed metadata still has no actual work' } })
  await invoke('complete', { ref: ref(h.ctx.goals.get(agent)) })
  continueCheckpoint.release()
  await agent.whenIdle()
  assertRunning((await h.sync(agent.id)).board.cards[0], 'suspended')
  assert.equal(h.adapter.requests.length, 2, 'no new actual model request after metadata resume/complete')
  await assert.rejects(h.review(agent.id), stale)
})

test('external human pause with the real Goal round driver records user aborted, while idle Stop cannot cancel completed output', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true, automaticGoals: true })
  const entered = latch(), release = latch()
  h.registerTool('create_then_wait', async (_args, exec) => {
    h.ctx.goals.create(exec.agent, { objective: 'Human will pause during this tool' })
    entered.release(); await release.wait(exec.signal); return 'Not reached'
  })
  h.adapter.enqueue(toolResponse('create_then_wait'))
  const agent = await h.create('human-pause')
  await h.add(agent.id); prompt(agent); await entered.promise
  const invoke = goalGateway(h, agent)
  await invoke('pause', { ref: ref(h.ctx.goals.get(agent)) }); await agent.whenIdle()
  const paused = (await h.sync(agent.id)).board.cards[0]
  assertRunning(paused, 'interrupted'); assert.match(paused.runtime.explanation, /用户已停止/)
  assert.equal(h.ctx.goals.get(agent).phase, 'paused')
  assert.deepEqual(eventsOf(await h.readEvents(agent.id), 'turn/end').at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } })
  // Paused goal cannot swallow a later independent human execution.
  h.adapter.enqueue(textResponse('Independent human prompt with the old paused Goal'))
  prompt(agent, 'New task while the old goal remains paused'); await agent.whenIdle()
  const pending = (await h.sync(agent.id)).board.cards[0]
  assertPending(pending); assert(pending.runtime.episodeOrder > paused.runtime.episodeOrder)
  agent.cancel({ kind: 'user' })
  sameResult((await h.sync(agent.id)).board.cards[0], pending)
})

test('accepted and pending results distinguish idle/no-op Stop from actual claimed no-step cancellation, including archived background sync', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  for (const accept of [false, true]) {
    const agent = await h.create(`no-step-cancel-${accept}`)
    h.adapter.enqueue(textResponse('Old completed actual output')); prompt(agent); await agent.whenIdle(); await h.add(agent.id)
    if (accept) await h.review(agent.id)
    const before = await h.card(agent.id)
    agent.cancel({ kind: 'user' })
    sameResult((await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id), before)
    const stopNoop = h.on('agent/status', ({ agent: candidate, status }) => { if (candidate === agent && status === 'running') candidate.inbox.clear() })
    prompt(agent, 'Removed before claim; actual empty wake'); await agent.whenIdle(); stopNoop()
    // Observing the temporary open preparation revokes freshness, so its CAS
    // may advance even though the settled episode/time/decision must not change.
    sameResult((await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id), before, false)
    await h.mutate({ type: 'archive', sessionId: agent.id, membershipId: before.membershipId, expectedMetadataRevision: before.metadataRevision, archived: true, confirmedRunning: true })
    const archivedAt = (await h.card(agent.id)).archivedAt
    const entered = latch(), release = latch(), requests = h.adapter.requests.length
    const stop = h.on('agent/pre-step', async ({ agent: candidate, signal }, next) => {
      if (candidate !== agent) return next()
      entered.release(); await release.wait(signal); return next()
    })
    prompt(agent, 'Claimed, but user cancels before model step'); await entered.promise
    const running = (await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    assertRunning(running); assert(running.runtime.episodeOrder > before.runtime.episodeOrder)
    agent.cancel({ kind: 'user' }); await agent.whenIdle(); stop()
    const cancelled = (await h.sync(agent.id)).board.cards.find(value => value.sessionId === agent.id)
    assertRunning(cancelled, 'interrupted'); assert.equal(cancelled.archivedAt, archivedAt)
    assert.equal(cancelled.decision, null); assert.match(cancelled.runtime.explanation, /用户已停止/)
    assert.equal(h.adapter.requests.length, requests, 'actual canceled attempt had an Inbox claim, but no model step')
    await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error' && error.details.reason === 'INVALID', 'archived cards are read-only')
    const events = await h.readEvents(agent.id), starts = eventsOf(events, 'turn/start')
    const cancelledEvents = events.slice(starts.at(-1).seq)
    assert.equal(eventsOf(cancelledEvents, 'step/start').length, 0)
    assert(eventsOf(cancelledEvents, 'agent/inbox/spliced').some(event => event.data.removedCount > 0 && event.data.outcome !== 'canceled'))
    assert.deepEqual(eventsOf(cancelledEvents, 'turn/end').at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } })
    await h.mutate({ type: 'archive', sessionId: agent.id, membershipId: cancelled.membershipId, expectedMetadataRevision: cancelled.metadataRevision, archived: false, confirmedRunning: true })
    assertRunning(await h.card(agent.id), 'interrupted')
    assert.equal((await h.card(agent.id)).archivedAt, null)
    await assert.rejects(h.mutate({ type: 'review', ...workflowBinding(before), action: 'accept', confirmed: true, destination: { kind: 'stay' } }), error => error.code === 'dashboard/error' && error.details.reason === 'CONFLICT')
  }
})

test('new Goal replacement and zero-work completion cannot reuse an accepted prior Goal turn', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), { h, agent, card, invoke } = await completedGoal(workspace, 'goal-replacement')
  await h.review(agent.id)
  await invoke('create', { request: { objective: 'A different Goal with no actual model work', maxGoalRounds: 3 } })
  const active = (await h.sync(agent.id)).board.cards[0]
  assertRunning(active, 'continuation_pending'); assert(active.runtime.episodeOrder > card.runtime.episodeOrder)
  assert.notEqual(active.runtime.episodeId, card.runtime.episodeId); assert.equal(active.decision, null)
  await invoke('complete', { ref: ref(h.ctx.goals.get(agent)) })
  assertRunning((await h.sync(agent.id)).board.cards[0], 'suspended')
  assert.equal(h.adapter.requests.length, 2)
  await assert.rejects(h.review(agent.id), stale)
  await invoke('clear', { ref: ref(h.ctx.goals.get(agent)) })
  assertRunning((await h.sync(agent.id)).board.cards[0], 'suspended')
})

test('manual Goal blocker retains its authoritative reason and only actual work after explicit resume can complete it', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true, automaticGoals: true })
  h.registerTool('manual_blocker', async (_args, exec) => {
    const goal = h.ctx.goals.create(exec.agent, { objective: 'Wait for a real human-owned prerequisite', maxGoalRounds: 3 })
    h.ctx.goals.block(exec.agent, ref(goal), { code: 'human-needed', message: 'Need a human to supply the required test fixture.' })
    return 'Blocked deliberately, not completed'
  })
  h.adapter.enqueue(toolResponse('manual_blocker'), textResponse('Current turn ended; blocker remains'))
  const agent = await h.create('manual-block')
  await h.add(agent.id); prompt(agent); await agent.whenIdle()
  const blocked = (await h.sync(agent.id)).board.cards[0]
  assertRunning(blocked, 'suspended'); assert.match(blocked.runtime.explanation, /human-needed.*required test fixture/)
  assert.equal(h.ctx.goals.get(agent).activation, 'disarmed')
  assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/end').at(-1).data.reason.kind, 'completed')
  await assert.rejects(h.review(agent.id), stale)
  const entered = latch(), release = latch()
  h.registerTool('finish_resumed_blocker', async (_args, exec) => {
    h.ctx.goals.complete(exec.agent, ref(h.ctx.goals.get(exec.agent)))
    return 'A new actual automatic round completed the resumed Goal'
  })
  h.adapter.enqueue(async function* (request) {
    entered.release(); await release.wait(request.signal); yield* toolResponse('finish_resumed_blocker')
  }, textResponse('Real resumed output'))
  const invoke = goalGateway(h, agent)
  await invoke('resume', { ref: ref(h.ctx.goals.get(agent)) }); await entered.promise
  const resumed = (await h.sync(agent.id)).board.cards[0]
  assertRunning(resumed); assert(resumed.runtime.episodeOrder > blocked.runtime.episodeOrder)
  release.release(); await agent.whenIdle()
  const pending = (await h.sync(agent.id)).board.cards[0]
  assertPending(pending); assert.equal(pending.runtime.episodeId, resumed.runtime.episodeId)
  const events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'turn/end').length, 2)
  assert.equal(eventsOf(events, 'user/message').filter(event => event.data.source.kind === 'goal').length, 1)
  assert.equal(h.adapter.plans.length, 0)
})
