import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { LifecycleJournal, readLiveGoal, readQuestions } from '../lib/backend/lifecycle.js'
import { runtimeSchema } from '../lib/shared/model.js'
import { capabilities } from './tools/sdk.mjs'

const header = (id = 'session') => ({ id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
const idle = { sourceLive: true, status: 'idle', goal: null, goalAvailable: false, questions: [], inputWaits: 0, approvalWaits: 0 }
const running = { ...idle, status: 'running' }
function setup() {
  const session = Session.create(SessionId('session'))
  const journal = new LifecycleJournal(session.header, 0)
  const events = []
  const append = (type, data, ...rest) => { const event = session.append(type, data, ...rest); events.push(event); journal.append(event); return event }
  const fact = (environment = idle) => runtimeSchema.parse(journal.fact(environment))
  const begin = (turn = 1) => { append('turn/start', { turn }); return append('step/start', { turn, step: 1 }) }
  const prompt = (source = { kind: 'user' }) => append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'a prompt' }] }), { surfaceOp: 'append' })
  return { session, journal, events, append, begin, prompt, fact }
}
function goalChange(operation, revision, phase, roundsStarted = 0, id = 'goal-a') {
  return { kind: 'goal/change', version: 1, operation, goal: { id, revision, phase, objective: 'Goal objective', maxGoalRounds: 3,
    ...(phase === 'blocked' ? { blockedReason: { code: 'human-needed', message: 'Need human action' } } : {}) }, roundsStarted, createdAt: 0, updatedAt: revision }
}
const withGoal = (phase = 'active', activation = 'armed', roundsStarted = 0, revision = 1) => ({ ...idle, goalAvailable: true,
  goal: { id: 'goal-a', revision, phase, activation, roundsStarted, maxGoalRounds: 3 } })

test('not started is distinct from unknown, running, and a completed whole turn', () => {
  const h = setup()
  assert.equal(h.fact().phase, 'not_started')
  h.begin(); h.prompt()
  h.append('step/end', { turn: 1, step: 1 })
  assert.equal(h.fact(running).phase, 'running', 'step end never completes a whole turn')
  h.append('step/start', { turn: 1, step: 2 }); h.append('step/end', { turn: 1, step: 2 })
  assert.equal(h.fact(running).phase, 'running')
  const end = h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const completed = h.fact()
  assert.equal(completed.phase, 'completed'); assert.equal(completed.endedAt, end.time)
  assert.equal(completed.cursor, h.session.seq); assert.equal(completed.episodeOrder, 1)
})

test('all authoritative non-normal turn endings remain in progress hints', () => {
  for (const [kind, expected] of [['error', 'failed'], ['aborted', 'interrupted'], ['interrupted', 'interrupted'], ['forked', 'interrupted'], ['blocked', 'suspended'], ['max-tokens', 'suspended'], ['future-reason', 'suspended']]) {
    const h = setup(); h.begin()
    h.append('turn/end', { turn: 1, reason: { kind } })
    const fact = h.fact()
    assert.equal(fact.phase, expected, kind); assert.equal(fact.endedAt, null, kind)
  }
})

test('new real execution reopens with a monotonic durable identity, not an idle guess', () => {
  const h = setup(); h.begin(); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const first = h.fact()
  const preparing = h.fact(running)
  assert.equal(preparing.sync, 'unknown'); assert.equal(preparing.episodeId, first.episodeId)
  h.begin(2)
  const second = h.fact(running)
  assert.equal(second.phase, 'running'); assert.notEqual(second.episodeId, first.episodeId); assert(second.episodeOrder > first.episodeOrder)
})

test('metadata and repeated immutable events leave the terminal fingerprint stable', () => {
  const h = setup(); h.begin(); const end = h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const first = h.fact()
  h.journal.append(end)
  h.append('session/title', { title: 'Renamed', messageSeqs: [], source: { kind: 'user' } })
  const after = h.fact()
  assert.equal(first.fingerprint, after.fingerprint); assert.equal(first.endedAt, after.endedAt)
  assert(after.cursor > first.cursor); assert.equal(h.journal.title, 'Renamed')
})

test('goal anchors span automatic full turns and last allowed-round gap until durable block', () => {
  const h = setup(); h.begin(); h.prompt(); h.append('goal/change', goalChange('create', 1, 'active'))
  const anchor = h.fact({ ...withGoal(), status: 'running' })
  h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(h.fact(withGoal()).phase, 'continuation_pending')
  for (let round = 1; round <= 3; round++) {
    h.begin(round + 1); h.prompt({ kind: 'goal', goalId: 'goal-a', revision: 1, round })
    const open = h.fact({ ...withGoal('active', 'armed', round), status: 'running' })
    assert.equal(open.episodeId, anchor.episodeId); assert.equal(open.phase, 'running')
    h.append('turn/end', { turn: round + 1, reason: { kind: 'completed' } })
    const gap = h.fact(withGoal('active', 'armed', round))
    assert.equal(gap.episodeId, anchor.episodeId); assert.equal(gap.phase, 'continuation_pending'); assert.equal(gap.endedAt, null)
  }
  h.append('goal/change', goalChange('block', 2, 'blocked', 3))
  assert.equal(h.fact(withGoal('blocked', 'disarmed', 3, 2)).phase, 'suspended')
})

test('goal completion midturn is not final until matching normal full turn end', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
  h.append('goal/change', goalChange('complete', 2, 'complete'))
  assert.equal(h.fact({ ...withGoal('complete', 'disarmed', 0, 2), status: 'running' }).phase, 'running')
  const end = h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const fact = h.fact(withGoal('complete', 'disarmed', 0, 2))
  assert.equal(fact.phase, 'completed'); assert(fact.endedAt >= end.time)
})

test('goal-only completion cannot borrow an earlier unrelated normal end', () => {
  const h = setup(); h.begin(); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  h.append('goal/change', goalChange('create', 1, 'active')); h.append('goal/change', goalChange('complete', 2, 'complete'))
  assert.notEqual(h.fact(withGoal('complete', 'disarmed', 0, 2)).phase, 'completed')
})

test('paused/blocked and active disarmed goals stay suspended; explicit resume has a new durable episode', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active')); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const first = h.fact(withGoal())
  assert.equal(h.fact(withGoal('active', 'disarmed')).phase, 'suspended')
  assert.equal(h.fact({ ...idle, sourceLive: false }).phase, 'suspended')
  h.append('goal/change', goalChange('pause', 2, 'paused'))
  assert.equal(h.fact(withGoal('paused', 'disarmed', 0, 2)).phase, 'suspended')
  h.append('goal/change', goalChange('resume', 3, 'active'))
  const resumed = h.fact(withGoal('active', 'armed', 0, 3))
  assert(resumed.episodeOrder > first.episodeOrder); assert.notEqual(resumed.episodeId, first.episodeId)
  assert.equal(resumed.phase, 'continuation_pending')
})

test('new human prompt reopens active goal and ordinary turn after paused goal is independent', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active')); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const old = h.fact(withGoal())
  h.begin(2); h.prompt()
  assert(h.fact({ ...withGoal(), status: 'running' }).episodeOrder > old.episodeOrder)
  h.append('goal/change', goalChange('pause', 2, 'paused')); h.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  h.begin(3); h.prompt(); h.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  assert.equal(h.fact(withGoal('paused', 'disarmed', 0, 2)).phase, 'completed')
})

test('goal replay and unknown host fields fail closed at their real boundary', () => {
  const h = setup(); h.append('goal/change', goalChange('create', 1, 'active'))
  assert.throws(() => h.prompt({ kind: 'goal', goalId: 'goal-a', revision: 9, round: 1 }), /goal replay/)
  assert.throws(() => readLiveGoal({ id: 'g', revision: 1, phase: 'active', activation: 'maybe', roundsStarted: 0, maxGoalRounds: 2 }))
  assert.throws(() => readQuestions({ active: [{ callId: 'q', state: 'closed' }] }))
  assert.throws(() => readQuestions({ active: [{ callId: 'q', state: 'open' }, { callId: 'q', state: 'continued' }] }))
})

test('open raw cold turns stay unknown/suspended, not synthetic interrupted or normal', () => {
  const h = setup(); h.begin()
  h.append('approval/asked', { id: 'a', toolName: 'bash' })
  const fact = h.fact({ ...idle, sourceLive: false, status: null })
  assert.equal(fact.sync, 'unknown'); assert.equal(fact.phase, 'suspended'); assert.equal(fact.cursor, 3)
})

test('timed continued questions outrank a normal turn end; absent projector cannot guess completion', () => {
  const h = setup(); h.begin()
  h.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'ask_user_question', description: 'Ask', parameters: { type: 'object', properties: { timeout: { type: 'number' } } } }] } })
  h.append('tool/call', { turn: 1, step: 1, callId: 'q', name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Choose"}]}' })
  h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(h.fact({ ...idle, questions: [{ callId: 'q', state: 'continued' }] }).phase, 'waiting_input')
  // rc.1 has no timed schema/projector: a timeout-shaped legacy call cannot
  // manufacture the newer continued-wait contract after its turn has closed.
  assert.equal(h.fact({ ...idle, questions: null }).sync, capabilities.timedQuestions ? 'unknown' : 'synced')
  assert.equal(h.fact({ ...idle, questions: [] }).phase, 'completed')
})

test('ordinary fork owns no inherited completion and open-parent synthetic closer is not a child run', () => {
  const original = setup(); original.begin(); original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const inherited = original.events
  const forkHeader = { ...header('fork'), parentSession: SessionId('session'), isSeeded: true }
  const journal = new LifecycleJournal(forkHeader, inherited.length)
  inherited.forEach(event => journal.append(event))
  assert.equal(journal.fact(idle).phase, 'not_started'); assert.equal(journal.fact(idle).episodeId, null)
  const open = Session.create(SessionId('open'))
  const openEvent = open.append('turn/start', { turn: 1 })
  const forked = new LifecycleJournal(forkHeader, 1)
  forked.append(openEvent)
  forked.append({ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'forked' } } })
  assert.equal(forked.fact(idle).phase, 'not_started'); assert.equal(forked.fact(idle).episodeId, null)
  assert.equal(SessionLogOffset(1), 1)
})

test('bare no-op turn preserves previous settled episode and never manufactures review', () => {
  const h = setup()
  h.append('turn/start', { turn: 1 })
  assert.equal(h.fact(running).sync, 'unknown'); assert.equal(h.fact(running).episodeId, null)
  h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(h.fact().phase, 'not_started'); assert.equal(h.fact().episodeId, null)
  h.begin(2); h.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const completed = h.fact()
  assert.equal(foldConsumedWork(h.events).end.seq, h.events.at(-1).seq)
  h.append('turn/start', { turn: 3 })
  const preparing = h.fact(running)
  assert.equal(preparing.sync, 'unknown'); assert.equal(preparing.episodeId, completed.episodeId)
  h.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  const noOp = h.fact()
  assert.equal(noOp.phase, 'completed'); assert.equal(noOp.episodeId, completed.episodeId)
  assert.equal(noOp.endedAt, completed.endedAt); assert.equal(noOp.fingerprint, completed.fingerprint)
  assert.equal(foldConsumedWork(h.events).end.seq, h.events.at(-3).seq, 'official consumed-work fold also ignores the no-op')
})

test('unrelated extensible SDK events allow scalar/string/array/null without poisoning a terminal episode', () => {
  const h = setup(); h.begin(); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const before = h.fact()
  for (const data of [7, 'custom value', ['plugin', 42], null]) {
    const event = h.append('custom/probe', data)
    const after = h.fact()
    assert.equal(event.data, h.events.at(-1).data, 'real SDK accepted the custom JSON payload')
    assert.equal(after.phase, 'completed'); assert.equal(after.episodeId, before.episodeId)
    assert.equal(after.fingerprint, before.fingerprint); assert.equal(after.endedAt, before.endedAt)
    assert.equal(after.cursor, h.session.seq); assert.equal(h.journal.lastEvent, event)
  }
})

test('claimed no-step inputs are real attempts but a completed empty admission has no reviewable output', () => {
  for (const [kind, phase] of [['completed', 'suspended'], ['blocked', 'suspended'], ['error', 'failed'], ['aborted', 'interrupted']]) {
    const h = setup()
    h.append('turn/start', { turn: 1 })
    h.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    assert.equal(h.fact(running).phase, 'running')
    h.append('turn/end', { turn: 1, reason: { kind } })
    const fact = h.fact()
    assert.equal(fact.phase, phase, kind); assert.equal(fact.endedAt, null); assert.equal(fact.episodeOrder, 1)
    assert.equal(Boolean(foldConsumedWork(h.events).end), kind !== 'completed', 'official fold only accounts nonnormal no-step claims')
  }
})

const clearGoal = (revision, id = 'goal-a') => ({ kind: 'goal/change', version: 1, operation: 'clear', cleared: { id, revision }, clearedAt: revision })

test('D01/D02 completed Goal edit and clear retain exact terminal time, fingerprint and replay identity', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
  h.append('goal/change', goalChange('complete', 2, 'complete'))
  h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const completed = h.fact(withGoal('complete', 'disarmed', 0, 2))
  for (const revision of [3, 4]) {
    h.append('goal/change', goalChange('edit', revision, 'complete'))
    const edited = h.fact(withGoal('complete', 'disarmed', 0, revision))
    assert.equal(edited.phase, 'completed'); assert.equal(edited.endedAt, completed.endedAt)
    assert.equal(edited.fingerprint, completed.fingerprint); assert.equal(edited.episodeId, completed.episodeId)
    assert(edited.cursor > completed.cursor)
    assert.equal(h.fact(withGoal('complete', 'disarmed', 0, revision - 1)).sync, 'unknown', 'metadata does not relax exact live revision validation')
  }
  h.append('goal/change', clearGoal(5))
  const cleared = h.fact({ ...idle, goalAvailable: true })
  assert.equal(cleared.phase, 'completed'); assert.equal(cleared.endedAt, completed.endedAt)
  assert.equal(cleared.fingerprint, completed.fingerprint); assert.equal(cleared.episodeId, completed.episodeId)
  const replay = new LifecycleJournal(h.session.header, 0)
  h.events.forEach(event => replay.append(event))
  assert.deepEqual(replay.fact({ ...idle, goalAvailable: true }), cleared)
  assert.equal(replay.fact({ ...idle, sourceLive: false, status: null }).phase, 'completed')
})

test('complete then clear inside a tool still requires the same real normal turn end, not the metadata', () => {
  for (const kind of ['completed', 'aborted']) {
    const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
    h.append('goal/change', goalChange('complete', 2, 'complete')); h.append('goal/change', clearGoal(3))
    assert.equal(h.fact({ ...running, goalAvailable: true }).phase, 'running')
    h.append('turn/end', { turn: 1, reason: { kind, ...(kind === 'aborted' ? { reason: { kind: 'user' } } : {}) } })
    const fact = h.fact({ ...idle, goalAvailable: true })
    assert.equal(fact.phase, kind === 'completed' ? 'completed' : 'interrupted')
    if (kind === 'aborted') assert.match(fact.explanation, /用户已停止/)
  }
})

test('clearing unfinished active, paused or blocked Goals cannot turn leftover same-turn steps into review', () => {
  for (const phase of ['active', 'paused', 'blocked']) {
    const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
    if (phase !== 'active') h.append('goal/change', goalChange(phase === 'paused' ? 'pause' : 'block', 2, phase))
    const before = h.fact({ ...withGoal(phase, phase === 'active' ? 'armed' : 'disarmed', 0, phase === 'active' ? 1 : 2), status: 'running' })
    h.append('goal/change', clearGoal(phase === 'active' ? 2 : 3))
    h.append('step/end', { turn: 1, step: 1 }); h.append('step/start', { turn: 1, step: 2 })
    h.append('step/end', { turn: 1, step: 2 }); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const cleared = h.fact({ ...idle, goalAvailable: true })
    assert.equal(cleared.sync, 'synced'); assert.equal(cleared.phase, 'suspended'); assert.equal(cleared.endedAt, null)
    assert.equal(cleared.episodeId, before.episodeId); assert.match(cleared.explanation, /未完成目标已清除/)
    h.append('turn/start', { turn: 2 }); h.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    assert.equal(h.fact({ ...idle, goalAvailable: true }).phase, 'suspended', 'empty wake does not repair cancellation')
    h.begin(3); h.prompt(); h.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const next = h.fact({ ...idle, goalAvailable: true })
    assert.equal(next.phase, 'completed'); assert(next.episodeOrder > cleared.episodeOrder)
  }
})

test('unfinished Goal clear plus actual user abort is interrupted, not a normal clear or completed result', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
  h.append('goal/change', clearGoal(2))
  h.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const fact = h.fact({ ...idle, goalAvailable: true })
  assert.equal(fact.phase, 'interrupted'); assert.equal(fact.endedAt, null); assert.match(fact.explanation, /用户已停止.*清除/)
})

test('pause normal end and explicit resume with no actual work never become pending by metadata alone', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
  h.append('goal/change', goalChange('pause', 2, 'paused')); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const paused = h.fact(withGoal('paused', 'disarmed', 0, 2))
  assert.equal(paused.phase, 'suspended'); assert.match(paused.explanation, /暂停/)
  h.append('goal/change', goalChange('resume', 3, 'active'))
  const resumed = h.fact(withGoal('active', 'armed', 0, 3))
  assert(resumed.episodeOrder > paused.episodeOrder); assert.equal(resumed.phase, 'continuation_pending'); assert.equal(resumed.endedAt, null)
  h.append('goal/change', goalChange('edit', 4, 'active'))
  h.append('goal/change', goalChange('complete', 5, 'complete'))
  assert.equal(h.fact(withGoal('complete', 'disarmed', 0, 5)).phase, 'suspended', 'resume+complete without execution cannot borrow the pre-resume normal end')
})

test('new Goal replaces complete Goal with a new episode and cannot borrow the previous result', () => {
  const h = setup(); h.begin(); h.append('goal/change', goalChange('create', 1, 'active'))
  h.append('goal/change', goalChange('complete', 2, 'complete')); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const first = h.fact(withGoal('complete', 'disarmed', 0, 2))
  h.append('goal/change', goalChange('create', 1, 'active', 0, 'goal-b'))
  const secondEnvironment = { ...withGoal(), goal: { ...withGoal().goal, id: 'goal-b' } }
  const second = h.fact(secondEnvironment)
  assert.equal(second.phase, 'continuation_pending'); assert.notEqual(second.episodeId, first.episodeId); assert(second.episodeOrder > first.episodeOrder)
  h.append('goal/change', goalChange('complete', 2, 'complete', 0, 'goal-b'))
  assert.equal(h.fact({ ...secondEnvironment, goal: { ...secondEnvironment.goal, revision: 2, phase: 'complete', activation: 'disarmed' } }).phase, 'suspended')
})

test('owned metadata cannot manufacture an episode from an inherited Goal or inherited completion', () => {
  for (const completed of [false, true]) {
    const parent = setup(); parent.begin(); parent.append('goal/change', goalChange('create', 1, 'active'))
    if (completed) parent.append('goal/change', goalChange('complete', 2, 'complete'))
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = new LifecycleJournal({ ...header('child'), parentSession: parent.session.id, isSeeded: true }, parent.events.length)
    parent.events.forEach(event => child.append(event))
    const revision = completed ? 3 : 2
    const edit = parent.session.append('goal/change', goalChange('edit', revision, completed ? 'complete' : 'active'))
    child.append(edit)
    const environment = withGoal(completed ? 'complete' : 'active', 'disarmed', 0, revision)
    assert.equal(child.fact(environment).episodeId, null); assert.notEqual(child.fact(environment).phase, 'completed')
    if (!completed) child.append(parent.session.append('goal/change', goalChange('complete', revision + 1, 'complete')))
    assert.equal(child.fact({ ...environment, goal: { ...environment.goal, phase: 'complete', revision: completed ? revision : revision + 1 } }).episodeId, null)
  }
})

test('claimed-but-no-step actual abort opens a new interrupted attempt; unclaimed cancel remains unknown', () => {
  for (const claim of [false, true]) {
    const h = setup(); h.begin(); h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const completed = h.fact()
    h.append('turn/start', { turn: 2 })
    if (claim) h.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    h.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const fact = h.fact()
    assert.equal(fact.sync, claim ? 'synced' : 'unknown')
    assert.equal(fact.phase, claim ? 'interrupted' : 'unknown')
    if (claim) { assert(fact.episodeOrder > completed.episodeOrder); assert.match(fact.explanation, /用户已停止/) }
    else assert.equal(fact.episodeId, completed.episodeId, 'unknown preparation cannot forge a new work episode')
  }
})

test('settled PTC questions require a timed projection only when the official host supports continued waits', () => {
  const h = setup(); h.begin()
  assert.equal(h.fact({ ...running, questions: null, inputWaits: 1 }).phase, 'waiting_input', 'legacy nested blocking wait still has its real waterfall overlay')
  h.append('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'nested', name: 'ask_user_question', arguments: {}, isError: false, content: [] })
  h.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const noProjector = h.fact({ ...idle, questions: null })
  assert.equal(noProjector.sync, capabilities.timedQuestions ? 'unknown' : 'synced')
  assert.equal(noProjector.phase, capabilities.timedQuestions ? 'unknown' : 'completed')
  assert.equal(h.fact({ ...idle, questions: [] }).phase, 'completed')
})

test('the runtime fact carries the live child agent count', () => {
  const h = setup()
  assert.equal(h.fact().activeAgents, 0)
  const parked = { ...idle, status: 'idle', activeAgents: 3 }
  h.begin(); h.prompt()
  assert.equal(h.fact(parked).activeAgents, 3)
})
