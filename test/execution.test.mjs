import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowBinding } from './helpers.mjs'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentOptions, assertLocalSdk, assertPending, assertRunning, denyNetwork, eventsOf,
  executionWorkspace, latch, packageRoot, prompt, textResponse, toolResponse, userMessage,
} from './tools/execution-host.mjs'

// This tier deliberately does not manufacture Session events, fake an Agent,
// replace a registry method, or provide in-memory host persistence. Only model
// chunks and human answerers are deterministic seams; the installed SDK owns
// Inbox admission, requests, tool execution, turn boundaries, JSONL and resume.
test('real AgentLoop tools and turn-stopping steps -> durable pending -> human Gateway accept -> actual resume/new turn', { timeout: 30000 }, async t => {
  denyNetwork(t)
  await assertLocalSdk()
  const workspace = await executionWorkspace(t)
  const h = await workspace.start()
  const firstEntered = latch(), firstRelease = latch(), toolEntered = latch(), toolRelease = latch()
  const secondEntered = latch(), secondRelease = latch(), stopEntered = latch(), stopRelease = latch()
  const extensionEntered = latch(), extensionRelease = latch(), finalStopEntered = latch(), finalStopRelease = latch()
  h.adapter.enqueue(
    async function* (request) { firstEntered.release(); await firstRelease.wait(request.signal); yield* toolResponse('execution_probe') },
    async function* (request) { secondEntered.release(); await secondRelease.wait(request.signal); yield* textResponse('Initial result is not the end of the turn') },
    async function* (request) { extensionEntered.release(); await extensionRelease.wait(request.signal); yield* textResponse('Turn-stopping extension completed') },
  )
  h.registerTool('execution_probe', async (_args, exec) => {
    toolEntered.release(); await toolRelease.wait(exec.signal); return 'Actual tool result'
  })
  let stopping = 0
  h.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.id !== 'normal') return
    stopping += 1
    if (stopping === 1) {
      stopEntered.release(); await stopRelease.wait(signal)
      agent.steer(userMessage('Internal turn-stopping extension'))
    } else { finalStopEntered.release(); await finalStopRelease.wait(signal) }
  })
  const agent = await h.create('normal')
  await h.add(agent.id)
  const initial = await h.card(agent.id)
  assert.equal(initial.runtime.phase, 'not_started', initial.runtime.explanation ?? 'fresh real session must have no execution')
  prompt(agent)
  await firstEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  firstRelease.release()
  await toolEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  assert.equal(eventsOf(await h.readEvents(agent.id), 'tool/call').length, 1)
  toolRelease.release()
  await secondEntered.promise
  let events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'tool/result').length, 1)
  assert.equal(eventsOf(events, 'turn/end').length, 0, 'tool result is not a complete turn')
  assertRunning((await h.sync(agent.id)).board.cards[0])
  secondRelease.release()
  await stopEntered.promise
  events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'step/end').length, 2)
  assert.equal(eventsOf(events, 'turn/end').length, 0, 'assistant stop and idle step boundary are not complete turns')
  assertRunning((await h.sync(agent.id)).board.cards[0])
  stopRelease.release()
  await extensionEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  extensionRelease.release()
  await finalStopEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  finalStopRelease.release()
  await agent.whenIdle()
  const pending = (await h.sync(agent.id)).board.cards[0]
  assertPending(pending)
  events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'turn/start').length, 1)
  assert.equal(eventsOf(events, 'step/start').length, 3)
  assert.equal(eventsOf(events, 'step/end').length, 3)
  assert.equal(eventsOf(events, 'turn/end').length, 1)
  assert.deepEqual(eventsOf(events, 'turn/end')[0].data.reason, { kind: 'completed' })
  assert.equal(eventsOf(events, 'user/message')[0].data.source.kind, 'user')
  assert.equal(h.adapter.requests.length, 3)
  assert(h.adapter.requests[1].messages.some(message => message.role === 'tool' && message.toolCallId))
  assert.equal(h.adapter.plans.length, 0)
  const diskPath = await h.ctx.sessionPersistence.resolveCurrentLog(agent.id)
  assert((await realpath(diskPath)).startsWith(await realpath(workspace.root)))
  const lines = (await readFile(diskPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines[0].type, 'session')
  assert.equal(lines.at(-1).type, 'turn/end', 'normal completion really exists in fsynced JSONL')

  const confirmed = (await h.mutate({ type: 'confirm_review', ...workflowBinding(pending) })).board.cards[0]
  const acceptCommand = { type: 'review', ...workflowBinding(confirmed), action: 'accept', confirmed: true, destination: { kind: 'stay' } }
  const requestId = 'c4d61570-8b97-422b-9df9-701a6d3d1e47'
  const acceptEnvelope = h.envelope(acceptCommand, requestId)
  const accepted = (await h.submit(acceptEnvelope)).board.cards[0]
  assert.equal(accepted.status, 'accepted')
  assert(accepted.acceptedAt !== null)
  const decision = structuredClone(accepted.decision)
  await h.close()

  // A completely new Cordis context and JSONL backend reopens the same temp
  // files. No live profile, host restart, browser fixture or memory state exists.
  const restarted = await workspace.start()
  let restored = await restarted.card(agent.id)
  assert.equal(restored.status, 'accepted')
  assert.equal(restored.runtime.sourceLive, false, 'cold JSONL evidence is not human-review authority')
  assert.deepEqual(restored.decision, decision)
  assert.equal(restarted.ctx.agents.list().length, 0, 'dashboard hydration never resumes cold Agents')
  const resumed = await restarted.create(agent.id, true)
  restored = (await restarted.sync(agent.id)).board.cards[0]
  assert.equal(restored.status, 'accepted')
  assert.equal(restored.runtime.sourceLive, true)
  assert.equal(restarted.adapter.requests.length, 0, 'resume without input does not run a model')
  await assert.rejects(restarted.submit(acceptEnvelope), error => error.code === 'dashboard/error' && error.details.reason === 'UNAVAILABLE', 'persisted receipt cannot bypass the old service epoch')
  assert.deepEqual((await restarted.card(agent.id)).decision, decision, 'durable decision survives restart without replay')

  const nextEntered = latch(), nextRelease = latch()
  restarted.adapter.enqueue(async function* (request) {
    nextEntered.release(); await nextRelease.wait(request.signal); yield* textResponse('A genuinely new execution')
  })
  prompt(resumed, 'New human follow-up after acceptance')
  await nextEntered.promise
  const reopened = (await restarted.sync(agent.id)).board.cards[0]
  assertRunning(reopened)
  assert.notEqual(reopened.runtime.episodeId, pending.runtime.episodeId)
  assert(reopened.runtime.episodeOrder > pending.runtime.episodeOrder)
  await assert.rejects(restarted.mutate(acceptCommand), error => error.code === 'dashboard/error' && error.details.reason === 'REVIEW_STALE')
  nextRelease.release()
  await resumed.whenIdle()
  assertPending((await restarted.sync(agent.id)).board.cards[0])
  const returned = (await restarted.review(agent.id, 'return')).board.cards[0]
  assert.equal(returned.status, 'in_progress')
  assert.equal(returned.runtime.phase, 'completed')
  assert.equal(returned.decision.kind, 'returned')
  await restarted.close()
  const third = await workspace.start()
  const returnedAfterRestart = await third.card(agent.id)
  assert.equal(returnedAfterRestart.status, 'in_progress')
  assert.deepEqual(returnedAfterRestart.decision, returned.decision, 'same old completion cannot undo return after restart')
  assert.equal(returnedAfterRestart.reviewAt, null)
  t.diagnostic(`SDK ${agentOptions.provider}: 1 turn / 3 real steps / 1 real tool; accepted decision + request receipt survive JSONL/SQLite reopen; new actual turn clears acceptance`)
})

test('real AgentLoop model failure, human abort and pre-step block never become pending; successful retry does', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const errors = []
  h.on('agent/error', payload => { errors.push(payload.error) })
  const agent = await h.create('non-normal')
  await h.add(agent.id)
  h.adapter.enqueue([{ type: 'finish', reason: { kind: 'error', failure: { code: 'DETERMINISTIC_FAILURE', message: 'Fixture model failure' } } }])
  prompt(agent)
  await agent.whenIdle()
  const failed = (await h.sync(agent.id)).board.cards[0]
  assertRunning(failed, 'failed')
  assert(errors.length > 0, 'real driver publishes the failure')
  let ends = eventsOf(await h.readEvents(agent.id), 'turn/end')
  assert.equal(ends.at(-1).data.reason.kind, 'error')
  assert.equal(ends.at(-1).data.reason.error.code, 'DETERMINISTIC_FAILURE')
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error')

  const abortEntered = latch(), abortRelease = latch()
  h.adapter.enqueue(async function* (request) { abortEntered.release(); await abortRelease.wait(request.signal); yield* textResponse('Should not finish') })
  prompt(agent, 'Abort this actual request')
  await abortEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  assertRunning((await h.sync(agent.id)).board.cards[0], 'interrupted')
  ends = eventsOf(await h.readEvents(agent.id), 'turn/end')
  assert.deepEqual(ends.at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } })

  const stopBlock = h.on('agent/pre-step', async ({ agent: candidate }, next) => candidate === agent ? { kind: 'reject' } : next())
  prompt(agent, 'Blocked before first request')
  await agent.whenIdle()
  const blocked = (await h.sync(agent.id)).board.cards[0]
  assert.equal(blocked.status, 'in_progress')
  assert.notEqual(blocked.runtime.phase, 'completed')
  ends = eventsOf(await h.readEvents(agent.id), 'turn/end')
  assert.equal(ends.at(-1).data.reason.kind, 'blocked')
  stopBlock()
  h.adapter.enqueue(textResponse('Retry succeeded'))
  prompt(agent, 'Retry successfully')
  await agent.whenIdle()
  assertPending((await h.sync(agent.id)).board.cards[0])
  assert.equal(h.adapter.plans.length, 0)
})

test('real Loader resolves built package exports and bundle identity, unload/remount retains durable acceptance', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const patch = await readFile(join(packageRoot, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /id: session-dashboard/)
  assert(patch.includes(`name: '${manifest.name}'`))
  assert.equal(h.entry.options.name, manifest.name)
  assert.equal(h.entry.moduleNamespace.name, 'session-dashboard')
  assert(h.ctx.typert.getPackage(manifest.name, 'host'), 'strict descriptor is registered by built package')
  const agent = await h.create('loader')
  h.adapter.enqueue(textResponse('Loader executed this actual Agent'))
  prompt(agent)
  await agent.whenIdle()
  await h.add(agent.id)
  assertPending(await h.card(agent.id))
  const accepted = (await h.review(agent.id)).board.cards[0]
  await h.entry.update({ disabled: true })
  assert.equal(h.ctx.get('sessionDashboard'), undefined)
  await assert.rejects(h.invoke('snapshot'))
  await h.entry.update({ disabled: false })
  await h.ctx.loader.await()
  await h.entry.fiber.await()
  const remounted = await h.card(agent.id)
  assert.equal(remounted.status, 'accepted')
  assert.deepEqual(remounted.decision, accepted.decision)
  assert.equal(remounted.acceptedAt, accepted.acceptedAt)
})

test('real user-question and approval tool waits remain in progress until the complete turn ends', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ questions: true, approval: true })
  const questionEntered = latch(), answer = latch(), approvalEntered = latch(), approve = latch()
  const finalEntered = latch(), finalRelease = latch()
  h.on('user-questions/request', async (request) => {
    questionEntered.release(); await answer.wait(request.signal)
    return { answers: [{ id: 'choice', selected: ['Continue'] }] }
  })
  h.on('approval/request', async request => {
    approvalEntered.release(); await approve.wait(request.signal); return 'allowed-once'
  })
  h.registerTool('execution_question', async (_args, exec) => {
    const result = await h.ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal,
      questions: [{ id: 'choice', question: 'Continue the actual tool?', options: [{ label: 'Continue' }] }] })
    return JSON.stringify(result)
  })
  h.registerTool('execution_approval', async (_args, exec) => h.ctx.approval.request({ agent: exec.agent,
    signal: exec.signal, toolName: exec.name, callId: exec.callId }))
  h.adapter.enqueue(toolResponse('execution_question'), toolResponse('execution_approval'), async function* (request) {
    finalEntered.release(); await finalRelease.wait(request.signal); yield* textResponse('All human waits settled')
  })
  const agent = await h.create('waiting')
  await h.add(agent.id)
  prompt(agent)
  await questionEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0], 'waiting_input')
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error')
  assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/end').length, 0)
  answer.release()
  await approvalEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0], 'waiting_approval')
  let events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'approval/asked').length, 1)
  assert.equal(eventsOf(events, 'approval/decided').length, 0)
  assert.equal(eventsOf(events, 'turn/end').length, 0)
  approve.release()
  await finalEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0])
  events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'approval/decided').length, 1)
  assert.equal(eventsOf(events, 'tool/result').length, 2)
  finalRelease.release()
  await agent.whenIdle()
  assertPending((await h.sync(agent.id)).board.cards[0])
  assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/start').length, 1, 'human answers continue the existing actual turn')
})

test('real empty wake cannot create a phantom review, while consumed-but-filtered input is suspended', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('empty-wake')
  h.adapter.enqueue(textResponse('Previously reviewed real work'))
  prompt(agent)
  await agent.whenIdle()
  await h.add(agent.id)
  const accepted = (await h.review(agent.id)).board.cards[0]
  const requests = h.adapter.requests.length
  // A synchronous observer clears the wake before Inbox claim. This is public
  // queue editing at a real driver boundary, not hand-written lifecycle events.
  const stopClear = h.on('agent/status', ({ agent: candidate, status }) => {
    if (candidate === agent && status === 'running') candidate.inbox.clear()
  })
  prompt(agent, 'This queued wake is removed before the driver can claim it')
  await agent.whenIdle()
  stopClear()
  let current = (await h.sync(agent.id)).board.cards[0]
  assert.equal(h.adapter.requests.length, requests, 'no-op wake issues no model request')
  assert.equal(current.status, 'accepted', 'bare completed turn cannot undo human acceptance')
  assert.equal(current.runtime.episodeId, accepted.runtime.episodeId)
  assert.deepEqual(current.decision, accepted.decision)
  let events = await h.readEvents(agent.id)
  const starts = eventsOf(events, 'turn/start')
  assert.equal(starts.length, 2)
  const noOp = events.slice(starts[1].seq)
  assert.equal(eventsOf(noOp, 'step/start').length, 0)
  assert.equal(eventsOf(noOp, 'user/message').length, 0)
  assert.equal(eventsOf(noOp, 'turn/end').at(-1).data.reason.kind, 'completed')

  const stopFilter = h.on('agent/pre-step', async ({ agent: candidate }, next) => candidate === agent
    ? { kind: 'enter', messages: [] } : next())
  prompt(agent, 'Claimed by the real Inbox, filtered before model admission')
  await agent.whenIdle()
  stopFilter()
  current = (await h.sync(agent.id)).board.cards[0]
  assertRunning(current, 'suspended')
  assert.notEqual(current.runtime.episodeId, accepted.runtime.episodeId)
  assert.equal(h.adapter.requests.length, requests)
  events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'turn/end').at(-1).data.reason.kind, 'completed')
  assert.equal(eventsOf(events, 'step/start').length, 1, 'only the original real work had a model step')
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error')
})

test('official goal-round driver crosses real turn idle gaps without review; goal complete inside a tool still waits for normal end', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true, automaticGoals: true })
  const gapEntered = latch(), gapRelease = latch(), automaticEntered = latch(), automaticRelease = latch()
  const completedInsideTool = latch(), completeToolRelease = latch(), finalEntered = latch(), finalRelease = latch()
  let heldGap = false
  let goalIdentity
  h.on('session/flush', async session => {
    const agent = h.ctx.agents.get(session.id)
    if (session.id !== 'goal-complete' || agent?.status !== 'idle' || heldGap || h.ctx.goals.get(agent)?.phase !== 'active') return
    heldGap = true
    gapEntered.release(); await gapRelease.promise
  })
  h.registerTool('execution_create_goal', async (_args, exec) => {
    const goal = h.ctx.goals.create(exec.agent, { objective: 'Verify the full isolated actual host execution', maxGoalRounds: 3 })
    goalIdentity = goal.id
    return 'Goal created using the actual public GoalService'
  })
  h.registerTool('execution_complete_goal', async (_args, exec) => {
    const goal = h.ctx.goals.get(exec.agent)
    h.ctx.goals.complete(exec.agent, { id: goal.id, revision: goal.revision })
    completedInsideTool.release(); await completeToolRelease.wait(exec.signal)
    return 'Goal marked complete but its tool and actual turn have not finished'
  })
  h.adapter.enqueue(
    toolResponse('execution_create_goal'), textResponse('Human-started turn finished; objective remains active'),
    async function* (request) { automaticEntered.release(); await automaticRelease.wait(request.signal); yield* textResponse('Automatic round one result') },
    toolResponse('execution_complete_goal'),
    async function* (request) { finalEntered.release(); await finalRelease.wait(request.signal); yield* textResponse('Final answer after goal completion') },
  )
  const agent = await h.create('goal-complete')
  await h.add(agent.id)
  prompt(agent)
  await gapEntered.promise
  assert.equal(agent.status, 'idle', 'real round driver is held at its durability boundary between turns')
  const gap = (await h.sync(agent.id)).board.cards[0]
  assertRunning(gap, 'continuation_pending')
  assert.equal(h.ctx.goals.get(agent).activation, 'armed')
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error')
  gapRelease.release()
  await automaticEntered.promise
  const automatic = (await h.sync(agent.id)).board.cards[0]
  assertRunning(automatic)
  assert.equal(automatic.runtime.episodeId, gap.runtime.episodeId, 'official automatic rounds are one logical goal episode')
  automaticRelease.release()
  await completedInsideTool.promise
  assert.equal(h.ctx.goals.get(agent).phase, 'complete')
  assertRunning((await h.sync(agent.id)).board.cards[0], 'running')
  completeToolRelease.release()
  await finalEntered.promise
  assertRunning((await h.sync(agent.id)).board.cards[0], 'running')
  finalRelease.release()
  await agent.whenIdle()
  const pending = (await h.sync(agent.id)).board.cards[0]
  assertPending(pending)
  assert.equal(pending.runtime.episodeId, gap.runtime.episodeId)
  const events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'turn/start').length, 3)
  assert.equal(eventsOf(events, 'turn/end').length, 3)
  assert(eventsOf(events, 'turn/end').every(event => event.data.reason.kind === 'completed'))
  const rounds = eventsOf(events, 'user/message').filter(event => event.data.source.kind === 'goal')
  assert.deepEqual(rounds.map(event => event.data.source.round), [1, 2])
  assert(rounds.every(event => event.data.source.goalId === goalIdentity))
  assert.equal(h.ctx.goals.get(agent).roundsStarted, 2)
  assert.equal(h.adapter.plans.length, 0)
  await h.review(agent.id)
  const humanEntered = latch(), humanRelease = latch()
  h.adapter.enqueue(async function* (request) {
    humanEntered.release(); await humanRelease.wait(request.signal); yield* textResponse('New human work after the old completed goal')
  })
  prompt(agent, 'Start genuinely new work after this Goal is already complete')
  await humanEntered.promise
  const newer = (await h.sync(agent.id)).board.cards[0]
  assertRunning(newer)
  assert.notEqual(newer.runtime.episodeId, gap.runtime.episodeId, 'a completed Goal cannot swallow later human work')
  humanRelease.release()
  await agent.whenIdle()
  assertPending((await h.sync(agent.id)).board.cards[0])
})

test('official goal round-limit and restart-disarmed activation remain suspended, never pending review', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true, automaticGoals: true })
  const limited = latch()
  h.on('goal/changed', ({ agent, change }) => {
    if (agent.id === 'goal-limit' && change.operation === 'block') limited.release()
  })
  h.registerTool('execution_limited_goal', async (_args, exec) => {
    h.ctx.goals.create(exec.agent, { objective: 'Deliberately leave a bounded goal unfinished', maxGoalRounds: 1 })
    return 'One automatic round is allowed'
  })
  h.adapter.enqueue(toolResponse('execution_limited_goal'), textResponse('Still active'), textResponse('Round budget consumed, goal not complete'))
  const agent = await h.create('goal-limit')
  await h.add(agent.id)
  prompt(agent)
  await limited.promise
  await agent.whenIdle()
  const blocked = (await h.sync(agent.id)).board.cards[0]
  assertRunning(blocked, 'suspended')
  const goal = h.ctx.goals.get(agent)
  assert.equal(goal.phase, 'blocked')
  assert.equal(goal.blockedReason.code, 'round-limit')
  assert.equal(goal.roundsStarted, 1)
  const events = await h.readEvents(agent.id)
  assert.equal(eventsOf(events, 'turn/end').length, 2)
  assert(eventsOf(events, 'turn/end').every(event => event.data.reason.kind === 'completed'), 'normal individual turns do not complete an unfinished goal')
  await assert.rejects(h.review(agent.id), error => error.code === 'dashboard/error')
  await h.close()
  const restarted = await workspace.start({ goals: true, automaticGoals: true })
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  const resumed = await restarted.create(agent.id, true)
  assert.equal(restarted.ctx.goals.get(resumed).activation, 'disarmed')
  assert.equal(restarted.ctx.goals.get(resumed).phase, 'blocked')
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  assert.equal(restarted.adapter.requests.length, 0, 'restart does not silently rearm a blocked goal or spend a model call')
})

test('active Goal loses process-local authority on actual JSONL resume and only explicit rearm drives the next real round', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start({ goals: true })
  h.registerTool('execution_unfinished_goal', async (_args, exec) => {
    h.ctx.goals.create(exec.agent, { objective: 'Resume an unfinished durable Goal after restarting the test context', maxGoalRounds: 3 })
    return 'Leave durable phase active'
  })
  h.adapter.enqueue(toolResponse('execution_unfinished_goal'), textResponse('First turn ended normally with Goal still active'))
  const agent = await h.create('goal-disarmed')
  await h.add(agent.id)
  prompt(agent)
  await agent.whenIdle()
  const armed = (await h.sync(agent.id)).board.cards[0]
  assertRunning(armed, 'continuation_pending')
  assert.equal(h.ctx.goals.get(agent).activation, 'armed')
  await h.close()

  const restarted = await workspace.start({ goals: true, automaticGoals: true })
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  const resumed = await restarted.create(agent.id, true)
  const disarmed = restarted.ctx.goals.get(resumed)
  assert.equal(disarmed.phase, 'active')
  assert.equal(disarmed.activation, 'disarmed')
  assertRunning((await restarted.sync(agent.id)).board.cards[0], 'suspended')
  assert.equal(restarted.adapter.requests.length, 0)
  const entered = latch(), release = latch(), completed = latch()
  restarted.registerTool('execution_resume_complete', async (_args, exec) => {
    const current = restarted.ctx.goals.get(exec.agent)
    restarted.ctx.goals.complete(exec.agent, { id: current.id, revision: current.revision })
    return 'Explicitly resumed Goal complete'
  })
  restarted.adapter.enqueue(async function* (request) {
    entered.release(); await release.wait(request.signal); yield* toolResponse('execution_resume_complete')
  }, textResponse('Final resumed Goal response'))
  restarted.on('goal/changed', ({ agent: candidate, change }) => {
    if (candidate === resumed && change.operation === 'complete') completed.release()
  })
  restarted.ctx.goals.resume(resumed, { id: disarmed.id, revision: disarmed.revision })
  await entered.promise
  const rearmed = (await restarted.sync(agent.id)).board.cards[0]
  assertRunning(rearmed)
  assert.notEqual(rearmed.runtime.episodeId, armed.runtime.episodeId, 'explicit rearm records a fresh review fence')
  release.release()
  await completed.promise
  await resumed.whenIdle()
  assertPending((await restarted.sync(agent.id)).board.cards[0])
  const rounds = eventsOf(await restarted.readEvents(agent.id), 'user/message').filter(event => event.data.source.kind === 'goal')
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].data.source.revision, disarmed.revision + 1)
})
