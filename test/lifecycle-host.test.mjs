import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionStore, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionPersistence, SessionPersistenceNotFoundError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { GoalService } from '@deepseek-ai/dsh-goal'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { observationSchema } from '../lib/shared/commands.js'
import { capabilities } from './tools/sdk.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
class MemoryPersistence extends SessionPersistence {
  records = new Map()
  opens = 0
  closes = 0
  reads = 0
  failure = null
  beforeRead = null
  beforeClose = null
  constructor(ctx) { super(ctx) }
  async create() { throw new Error('Not used: read-only test boundary') }
  async flush() {}
  async stat(id) { const record = this.records.get(id); return record ? { header: record.header, revision: SessionPersistenceRevision(`${record.events.length}`), eventCount: record.events.length } : undefined }
  async list() { return Promise.all([...this.records.keys()].map(id => this.stat(id))) }
  async open(id, access) {
    if (this.failure) throw this.failure
    assert.equal(access, 'read', 'dashboard must never take write ownership')
    const record = this.records.get(id)
    if (!record) throw new SessionPersistenceNotFoundError(id)
    this.opens += 1
    let closed = false
    const close = async () => { if (closed) return; closed = true; if (this.beforeClose) await this.beforeClose(); this.closes += 1 }
    return { id, access, header: record.header, inheritedEventCount: SessionLogOffset(record.inherited ?? 0),
      read: async (offset = 0, length) => { this.reads += 1; if (this.beforeRead) await this.beforeRead(id); return { events: structuredClone(record.events.slice(offset, length === undefined ? undefined : offset + length)), eventState: 'independent' } },
      close, [Symbol.asyncDispose]: close }
  }
  save(session, events = []) { this.records.set(session.id, { header: structuredClone(session.header), events: structuredClone(events), inherited: session.inheritedEventCount }) }
}
async function setup(t, { questions = false, goals = false } = {}) {
  const root = new Context(), fibers = []
  const fiber = root.plugin(scope => { new SessionStore(scope); new AgentRegistry(scope); new SessionQueryEngine(scope); new MemoryPersistence(scope); new SessionProjectionRegistry(scope) })
  fibers.push(fiber); await fiber.await()
  const ctx = fiber.ctx
  if (questions || goals) {
    for (const [plugin, config] of [[Registry, undefined], ...(questions ? [[UserQuestionService, {}]] : []), ...(goals ? [[GoalService, { defaultMaxGoalRounds: 3 }]] : [])]) {
      const child = ctx.plugin(plugin, config); fibers.push(child); await child.await()
    }
    await Promise.resolve()
  }
  const host = createDshHost(ctx)
  t.after(async () => { host.close(); for (const child of fibers.reverse()) await child.dispose() })
  let flushes = 0, flushError = null, onFlush = null
  const save = async session => {
    const source = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    try { ctx.sessionPersistence.save(session, source.events) } finally { source[Symbol.dispose]() }
  }
  ctx.on('session/flush', async session => { flushes += 1; if (flushError) throw flushError; if (onFlush) await onFlush(session); await save(session) })
  const add = async (id = 'a', options = {}) => {
    const session = ctx.sessions.create(SessionId(id), options)
    const agent = { id: session.id, session, status: 'idle', ctx, options: {}, inbox: { nextTurn: [], nextStep: [] } }
    await ctx.agents.register(agent)
    return { session, agent, events: agentEvents(ctx, agent), status(value) { agent.status = value; agentEvents(ctx, agent).emit('agent/status', { agent, status: value }) } }
  }
  const capture = async id => { const value = await host.capture(id); observationSchema.parse(value.observation); return value }
  return { ctx, host, add, capture, save, persistence: ctx.sessionPersistence,
    get flushes() { return flushes }, set flushError(value) { flushError = value }, set onFlush(value) { onFlush = value } }
}
function start(h, turn = 1) { h.status('running'); h.session.append('turn/start', { turn }); h.session.append('step/start', { turn, step: 1 }) }
function finish(h, turn = 1) { h.session.append('step/end', { turn, step: 1 }); h.session.append('turn/end', { turn, reason: { kind: 'completed' } }); h.status('idle') }
const prompt = (session, source = { kind: 'user' }) => session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'Hello' }] }), { surfaceOp: 'append' })

test('actual SDK live SessionQuery header/cursor retains capture and terminal durability', async t => {
  const h = await setup(t), live = await h.add()
  const empty = await h.capture('a')
  assert.equal(empty.observation.runtime.sync, 'synced'); assert.equal(empty.observation.runtime.phase, 'not_started')
  assert.equal(empty.observation.runtime.sourceLive, true); assert.equal(empty.validate(), true); assert.equal(h.flushes, 1)
  start(live); prompt(live.session)
  assert.equal(empty.validate(), false)
  const run = await h.capture('a'); assert.equal(run.observation.runtime.phase, 'running'); assert.equal(run.validate(), true)
  finish(live)
  assert.equal(run.validate(), false)
  const complete = await h.capture('a')
  assert.equal(complete.observation.runtime.sync, 'synced'); assert.equal(complete.observation.runtime.phase, 'completed'); assert.equal(complete.validate(), true)
  assert.equal(complete.observation.runtime.cursor, live.session.seq); assert.equal(h.flushes, 2)
  const again = await h.capture('a'); assert.equal(h.flushes, 2, 'one durable proof per immutable terminal cursor')
  assert.equal(again.observation.runtime.fingerprint, complete.observation.runtime.fingerprint)
  complete.dispose(); assert.equal(complete.validate(), false); empty.dispose(); run.dispose(); again.dispose()
  assert.equal(h.persistence.opens, h.persistence.closes)
})

test('documented missing delegationDepth equals JSONL zero, but other persisted identity differences fail closed', async t => {
  const h = await setup(t), live = await h.add()
  const originalSave = h.persistence.save.bind(h.persistence)
  h.persistence.save = (session, events) => {
    originalSave(session, events)
    const record = h.persistence.records.get(session.id)
    record.header = { ...record.header, delegationDepth: 0 }
  }
  const empty = await h.capture('a')
  assert.equal(empty.observation.runtime.sync, 'synced'); assert.equal(empty.observation.runtime.phase, 'not_started'); empty.dispose()
  start(live); finish(live)
  const completed = await h.capture('a')
  assert.equal(completed.observation.runtime.sync, 'synced'); assert.equal(completed.observation.runtime.phase, 'completed'); completed.dispose()
  // Use a new terminal cursor so the exact-Session durable proof is not cached.
  live.session.append('custom/header-check', null)
  h.persistence.save = (session, events) => {
    originalSave(session, events)
    const record = h.persistence.records.get(session.id)
    record.header = { ...record.header, delegationDepth: 0, cwd: '/different-persisted-identity' }
  }
  const mismatched = await h.capture('a')
  assert.equal(mismatched.observation.runtime.sync, 'unknown'); assert.match(mismatched.observation.runtime.explanation, /身份/)
  mismatched.dispose()
})

test('exact object fence and status prevent accepting after replacement or pre-turn wake', async t => {
  const h = await setup(t), live = await h.add()
  start(live); finish(live)
  const before = await h.capture('a'); assert.equal(before.validate(), true)
  live.status('running')
  assert.equal(before.validate(), false)
  const preparing = await h.capture('a'); assert.equal(preparing.observation.runtime.sync, 'unknown'); preparing.dispose()
  live.status('idle')
  const fresh = await h.capture('a')
  const originalGet = h.ctx.agents.get.bind(h.ctx.agents)
  h.ctx.agents.get = id => id === live.agent.id ? { ...live.agent } : originalGet(id)
  assert.equal(fresh.validate(), false, 'same id and status on another object is not authority')
  h.ctx.agents.get = originalGet
  fresh.dispose(); before.dispose()
})

test('synchronous fence detects goal activation without seq changes and resume reopens', async t => {
  const h = await setup(t, { goals: true }), live = await h.add()
  start(live); prompt(live.session)
  const goal = h.ctx.get('goals').create(live.agent, { objective: 'Implement a full goal' })
  finish(live)
  const pending = await h.capture('a'); assert.equal(pending.observation.runtime.phase, 'continuation_pending')
  const cursor = live.session.seq
  h.ctx.get('goals').disarm(live.agent)
  assert.equal(live.session.seq, cursor); assert.equal(pending.validate(), false)
  const suspended = await h.capture('a'); assert.equal(suspended.observation.runtime.phase, 'suspended')
  h.ctx.get('goals').resume(live.agent, { id: goal.id, revision: goal.revision })
  const resumed = await h.capture('a'); assert.equal(resumed.observation.runtime.phase, 'continuation_pending')
  assert(resumed.observation.runtime.episodeOrder > pending.observation.runtime.episodeOrder)
  for (const capture of [pending, suspended, resumed]) capture.dispose()
})

test('actual SDK question mode is capability-accurate: timed continuation or rc.1 blocking waterfall', async t => {
  const h = await setup(t, { questions: true }), live = await h.add()
  if (!capabilities.timedQuestions) {
    assert.equal(typeof h.ctx.get('userQuestions').askTimed, 'undefined', 'rc.1 must not invent timed continuation')
    start(live); prompt(live.session)
    live.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('legacy'), name: 'ask_user_question', arguments: '{}' })
    const blocking = await h.capture('a'); assert.equal(blocking.observation.runtime.phase, 'waiting_input'); blocking.dispose()
    live.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('legacy'), isError: false, content: [{ type: 'text', text: '{"answers":[]}' }] }) }, { surfaceOp: 'append' })
    finish(live)
    const complete = await h.capture('a'); assert.equal(complete.observation.runtime.phase, 'completed'); complete.dispose()
    return
  }
  start(live); prompt(live.session)
  live.session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'ask_user_question', description: 'Ask', parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'number' } } } }] } })
  live.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('q'), name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Choose"}]}' })
  const open = await h.capture('a'); assert.equal(open.observation.runtime.phase, 'waiting_input')
  live.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('q'), isError: false, content: [{ type: 'text', text: '{"pending":true}' }] }) }, { surfaceOp: 'append' })
  finish(live)
  const continued = await h.capture('a'); assert.equal(continued.observation.runtime.phase, 'waiting_input'); assert.equal(continued.validate(), true)
  await h.save(live.session)
  h.ctx.sessions.get = () => undefined
  h.ctx.agents.get = () => undefined
  const cold = await h.capture('a'); assert.equal(cold.observation.runtime.phase, 'waiting_input'); assert.equal(cold.observation.runtime.sourceLive, false)
  open.dispose(); continued.dispose(); cold.dispose()
})

test('legacy question and direct public question waterfall overlay preserve waits and clean up', async t => {
  const h = await setup(t), live = await h.add()
  start(live)
  const answer = deferred(), entered = deferred()
  const stop = h.ctx.on('user-questions/request', async () => { entered.resolve(); return answer.promise })
  const waiting = live.events.waterfall('user-questions/request', { agent: live.agent, questions: [{ id: 'q', question: 'Choose' }] }, async () => ({ answers: [] }))
  await entered.promise
  const capture = await h.capture('a'); assert.equal(capture.observation.runtime.phase, 'waiting_input')
  answer.resolve({ answers: [{ id: 'q', selected: ['Yes'] }] }); await waiting
  assert.equal(capture.validate(), false)
  const after = await h.capture('a'); assert.equal(after.observation.runtime.phase, 'running')
  live.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('legacy'), name: 'ask_user_question', arguments: '{}' })
  const legacy = await h.capture('a'); assert.equal(legacy.observation.runtime.phase, 'waiting_input')
  capture.dispose(); after.dispose(); legacy.dispose(); stop()
})

test('actual SDK approval audit/live waterfall waits, settlement and unmatched historical record', async t => {
  const h = await setup(t), live = await h.add()
  const serviceFiber = h.ctx.plugin(ApprovalService, { policy: 'ask' }); await serviceFiber.await()
  t.after(() => serviceFiber.dispose())
  start(live)
  const answer = deferred(), entered = deferred()
  h.ctx.on('approval/request', async () => { entered.resolve(); return answer.promise })
  const request = h.ctx.get('approval').request({ agent: live.agent, toolName: 'bash' })
  await entered.promise
  const capture = await h.capture('a'); assert.equal(capture.observation.runtime.phase, 'waiting_approval')
  answer.resolve('allowed-once'); await request
  assert.equal(capture.validate(), false)
  const after = await h.capture('a'); assert.equal(after.observation.runtime.phase, 'running')
  capture.dispose(); after.dispose()
  // A hot reload must not call an unmatched inherited/old asked event a live wait.
  await h.save(live.session)
  const seed = h.persistence.records.get('a').events
  const session = h.ctx.sessions.create(SessionId('historical'), { seed: [...seed, { seq: seed.length, time: Date.now(), type: 'approval/asked', data: { id: 'old', toolName: 'bash' } }] })
  const agent = { ...live.agent, id: session.id, session, status: 'running' }
  await h.ctx.agents.register(agent)
  const historical = await h.capture('historical'); assert.equal(historical.observation.runtime.sync, 'unknown'); assert.notEqual(historical.observation.runtime.phase, 'waiting_approval'); historical.dispose()
})

test('checkpoint failure and forged/no-op durability cannot advertise terminal authority', async t => {
  const h = await setup(t), live = await h.add()
  start(live); finish(live)
  h.flushError = new Error('disk failed')
  const failed = await h.capture('a'); assert.equal(failed.observation.runtime.sync, 'unknown'); assert.match(failed.observation.runtime.explanation, /disk failed/)
  h.flushError = null
  const okay = await h.capture('a'); assert.equal(okay.observation.runtime.sync, 'synced')
  failed.dispose(); okay.dispose()
})

test('new turn racing a terminal checkpoint cannot produce an old completed capture', async t => {
  const h = await setup(t), live = await h.add()
  start(live); finish(live)
  h.onFlush = () => { h.onFlush = null; start(live, 2) }
  const capture = await h.capture('a')
  assert.equal(capture.observation.runtime.phase, 'running'); assert.equal(capture.observation.runtime.cursor, live.session.seq); assert.equal(capture.validate(), true)
  capture.dispose()
})

test('raw cold journal never calls repaired prepared observations; missing versus unavailable is structured', async t => {
  const h = await setup(t)
  const cold = Session.create(SessionId('cold')); const event = cold.append('turn/start', { turn: 1 }); h.persistence.save(cold, [event])
  h.ctx.sessionQuery.observeSession = async () => { throw new Error('Prepared observations forbidden for cold capture') }
  const open = await h.capture('cold'); assert.equal(open.observation.runtime.phase, 'suspended'); assert.equal(open.observation.runtime.sync, 'unknown'); assert.equal(open.observation.runtime.cursor, 1)
  const missing = await h.capture('absent'); assert.equal(missing.observation.runtime.sync, 'missing')
  h.persistence.failure = new Error('permission denied')
  const unavailable = await h.capture('absent'); assert.equal(unavailable.observation.runtime.sync, 'unknown'); assert.match(unavailable.observation.runtime.explanation, /permission denied/)
  open.dispose(); missing.dispose(); unavailable.dispose(); assert.equal(h.persistence.opens, h.persistence.closes)
})

test('cold read close awaited and local attachment during hydration retries exact live source', async t => {
  const h = await setup(t)
  const cold = Session.create(SessionId('cold')); const seed = [cold.append('turn/start', { turn: 1 }), cold.append('step/start', { turn: 1, step: 1 }), cold.append('step/end', { turn: 1, step: 1 }), cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })]; h.persistence.save(cold, seed)
  const gate = deferred(), entered = deferred()
  h.persistence.beforeRead = async id => { if (id === 'cold') { entered.resolve(); await gate.promise; h.persistence.beforeRead = null } }
  const pending = h.capture('cold'); await entered.promise
  const live = await h.add('cold', { seed, meta: { createdAt: cold.header.createdAt } })
  gate.resolve()
  const capture = await pending
  assert.equal(capture.observation.runtime.sourceLive, true); assert.equal(capture.observation.runtime.phase, 'completed'); assert.equal(capture.validate(), true)
  assert.equal(capture.observation.runtime.cursor, live.session.seq); assert.equal(h.persistence.opens, h.persistence.closes); capture.dispose()
})

test('candidate corpus spans workspaces, uses latest public titles, preserves ordinary forks and excludes delegates', async t => {
  const h = await setup(t)
  const a = await h.add('a', { meta: { cwd: '/workspace/a' } }); const b = await h.add('b', { meta: { cwd: '/workspace/b', parentSession: a.session.id } })
  a.session.append('session/title', { title: 'Old name', messageSeqs: [], source: { kind: 'user' } })
  a.session.append('session/title', { title: 'Newest Alpha', messageSeqs: [], source: { kind: 'user' } })
  const cold = Session.create(SessionId('cold')); h.persistence.save(cold)
  h.ctx.sessions.create(SessionId('child'), { meta: { cwd: '/workspace/a', origin: 'subagent', parentSession: a.session.id, delegationDepth: 1 } })
  const all = await h.host.list({ search: '', offset: 0, limit: 100 })
  assert.deepEqual(new Set(all.items.map(row => row.sessionId)), new Set(['a', 'b', 'cold']))
  assert.equal(all.items.find(row => row.sessionId === 'a').title, 'Newest Alpha')
  assert.equal((await h.host.list({ search: 'workspace/b', offset: 0, limit: 1 })).items[0].sessionId, b.session.id)
  assert.equal((await h.host.list({ search: 'alpha', offset: 0, limit: 1 })).items[0].sessionId, 'a')
  const first = await h.host.list({ search: '', offset: 0, limit: 1 }); assert.equal(first.total, 3); assert.equal(first.nextOffset, 1)
  await assert.rejects(h.host.capture('child'), error => error.code === 'FORBIDDEN')
})

test('a delegated session can never become a board card, so the project status summary cannot count one', async t => {
  const h = await setup(t)
  const ordinary = await h.add('main', { meta: { cwd: '/workspace/a' } })
  // A fork keeps the lineage field but is an independent Session, not delegation.
  await h.add('fork', { meta: { cwd: '/workspace/a', parentSession: ordinary.session.id } })
  // A subagent Session is durable origin=subagent plus a delegation depth.
  h.ctx.sessions.create(SessionId('delegate'), { meta: { cwd: '/workspace/a', origin: 'subagent', parentSession: ordinary.session.id, delegationDepth: 1 } })
  // The candidate list is the only session picker, and it already drops the delegate.
  const candidates = await h.host.list({ search: '', offset: 0, limit: 100 })
  assert.deepEqual(new Set(candidates.items.map(row => row.sessionId)), new Set(['main', 'fork']))
  // capture is the only source add_card accepts, and it refuses the delegate: no
  // board card exists for it, so projectStatusCounts (which walks board.cards)
  // has nothing to add for a subagent run.
  await assert.rejects(h.host.capture('delegate'), error => error.code === 'FORBIDDEN')
  // Excluding by parentId would be wrong: this fork is a permitted independent card.
  const fork = await h.capture('fork')
  assert.equal(fork.observation.runtime.sync, 'synced')
  assert.equal(fork.validate(), true)
  fork.dispose()
})

test('retained live cache consumes append feed without a full journal read per event and closes leases', async t => {
  const h = await setup(t), live = await h.add()
  start(live)
  let snapshots = 0
  const original = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
  h.ctx.sessionQuery.observeSession = async (...args) => {
    const source = await original(...args)
    const retained = { source: source.source, header: source.header, inheritedEventCount: source.inheritedEventCount, cursor: source.cursor,
      projections: source.projections, retain: () => source.retain(), [Symbol.dispose]: () => source[Symbol.dispose](),
      get events() { snapshots += 1; return source.events } }
    return retained
  }
  const one = await h.capture('a')
  for (let step = 1; step <= 5; step++) { live.session.append('step/start', { turn: 1, step }); live.session.append('step/end', { turn: 1, step }); const c = await h.capture('a'); c.dispose() }
  assert.equal(snapshots, 1, 'only first hydration materializes a full public observation')
  h.host.close(); assert.equal(one.validate(), false)
  await assert.rejects(h.host.capture('a'), error => error.code === 'CLOSED')
  one.dispose()
})

test('scoped sibling Agent contexts deliver events and wait waterfall to untagged root adapter', async t => {
  const h = await setup(t)
  const liveAgents = []
  for (const id of ['scoped-a', 'scoped-b']) {
    const agent = { id: SessionId(id), status: 'idle', options: {}, inbox: { nextTurn: [], nextStep: [] } }
    const scope = createScope(h.ctx, agent)
    t.after(() => scope.dispose())
    agent.ctx = scope.ctx
    agent.session = scope.ctx.sessions.create(agent.id)
    await scope.ctx.agents.register(agent)
    const events = agentEvents(scope.ctx, agent)
    const live = { session: agent.session, agent, events, status(value) { agent.status = value; events.emit('agent/status', { status: value }) } }
    liveAgents.push(live)
  }
  const a = liveAgents[0], b = liveAgents[1]
  start(a); start(b)
  const capturedA = await h.capture(a.agent.id), capturedB = await h.capture(b.agent.id)
  assert.equal(capturedA.observation.runtime.phase, 'running'); assert.equal(capturedB.observation.runtime.phase, 'running')
  const answer = deferred(), entered = deferred()
  const stop = a.agent.ctx.on('user-questions/request', async () => { entered.resolve(); return answer.promise })
  const request = a.events.waterfall('user-questions/request', { questions: [{ id: 'q', question: 'Choose' }] }, async () => ({ answers: [] }))
  await entered.promise
  const waiting = await h.capture(a.agent.id); assert.equal(waiting.observation.runtime.phase, 'waiting_input')
  assert.equal(capturedA.validate(), false); assert.equal(capturedB.validate(), true, 'other scoped session fence stays valid')
  answer.resolve({ answers: [] }); await request
  assert.equal(waiting.validate(), false)
  for (const capture of [capturedA, capturedB, waiting]) capture.dispose()
  stop()
})

test('aborted public wait overlay releases immediately even if downstream answerer never resolves', async t => {
  const h = await setup(t), live = await h.add()
  start(live)
  const answer = deferred(), entered = deferred(), signal = new AbortController()
  h.ctx.on('user-questions/request', async () => { entered.resolve(); return answer.promise })
  const request = live.events.waterfall('user-questions/request', { signal: signal.signal, questions: [{ id: 'q', question: 'Choose' }] }, async () => ({ answers: [] }))
  await entered.promise
  const before = await h.capture('a'); assert.equal(before.observation.runtime.phase, 'waiting_input')
  signal.abort()
  assert.equal(before.validate(), false)
  const after = await h.capture('a'); assert.equal(after.observation.runtime.phase, 'running')
  answer.resolve({ answers: [] }); await request
  before.dispose(); after.dispose()
})

test('async cold read handle close is awaited and adapter shutdown prevents late capture publication', async t => {
  const h = await setup(t)
  const cold = Session.create(SessionId('cold')); h.persistence.save(cold)
  const gate = deferred(), entered = deferred()
  h.persistence.beforeClose = async () => { entered.resolve(); await gate.promise }
  const pending = h.host.capture('cold'); await entered.promise
  assert.equal(h.persistence.closes, 0)
  h.host.close(); gate.resolve()
  await assert.rejects(pending, error => error.code === 'CLOSED')
  assert.equal(h.persistence.closes, 1)
})

test('no-op completed turns do not create or replace a reviewable terminal episode', async t => {
  const h = await setup(t), live = await h.add()
  start(live); finish(live)
  const original = await h.capture('a')
  live.status('running'); live.session.append('turn/start', { turn: 2 })
  const preparing = await h.capture('a')
  assert.equal(preparing.observation.runtime.sync, 'unknown'); assert.equal(preparing.observation.runtime.episodeId, original.observation.runtime.episodeId)
  live.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }); live.status('idle')
  const after = await h.capture('a')
  assert.equal(after.observation.runtime.phase, 'completed'); assert.equal(after.observation.runtime.episodeId, original.observation.runtime.episodeId)
  assert.equal(after.observation.runtime.endedAt, original.observation.runtime.endedAt)
  assert.equal(after.observation.runtime.fingerprint, original.observation.runtime.fingerprint)
  for (const capture of [original, preparing, after]) capture.dispose()
})

test('durable tail read failure stays unknown and read handle closes on the error path', async t => {
  const h = await setup(t), live = await h.add()
  start(live); finish(live)
  h.persistence.beforeRead = async () => { throw new Error('tail read failed') }
  const failed = await h.capture('a')
  assert.equal(failed.observation.runtime.sync, 'unknown'); assert.match(failed.observation.runtime.explanation, /tail read failed/)
  assert.equal(h.persistence.opens, h.persistence.closes)
  failed.dispose()
})
