import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionStore, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistence, SessionPersistenceNotFoundError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { GoalService } from '@deepseek-ai/dsh-goal'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { DashboardService } from '../lib/backend/service.js'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { replayByteLength, replaySource, ReplayFold, REPLAY_BYTES_LIMIT, REPLAY_EVENT_LIMIT } from '../lib/backend/replay-source.js'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { denyNetwork, executionWorkspace, latch, prompt, textResponse } from './tools/execution-host.mjs'
import { capabilities } from './tools/sdk.mjs'
import { mutationFor, workflowBinding } from './helpers.mjs'

/** These fixtures use real public SDK Session/Goal/projection/observation code.
 * Persistence is an explicit in-memory backend boundary, not a real disk crash
 * test or a running AgentLoop. Every persisted record is copied on read/write. */
class MemoryPersistence extends SessionPersistence {
  records = new Map()
  counts = { stat: 0, open: 0, read: 0, flush: 0 }
  reads = []
  failure = null
  beforeRead = null
  async create() { throw new Error('read-only fixture') }
  async flush() { this.counts.flush += 1 }
  async stat(id) {
    this.counts.stat += 1
    const record = this.records.get(id)
    return record && { header: structuredClone(record.header), revision: SessionPersistenceRevision(`${record.revision}`), eventCount: record.events.length }
  }
  async list() { return Promise.all([...this.records.keys()].map(id => this.stat(id))) }
  async open(id, access) {
    this.counts.open += 1
    if (this.failure) throw this.failure
    assert.equal(access, 'read')
    const record = this.records.get(id)
    if (!record) throw new SessionPersistenceNotFoundError(id)
    const close = async () => {}
    return { id, access, header: structuredClone(record.header), inheritedEventCount: SessionLogOffset(record.inherited),
      read: async (offset = 0, length) => { this.counts.read += 1; this.reads.push([offset, length]); if (this.beforeRead) await this.beforeRead(id); return { events: structuredClone(record.events.slice(offset, length === undefined ? undefined : offset + length)), eventState: 'independent' } },
      close, [Symbol.asyncDispose]: close }
  }
  save(session, events) {
    const old = this.records.get(session.id)
    if (old && old.inherited === session.inheritedEventCount && JSON.stringify(old.events) === JSON.stringify(events)) return
    this.records.set(session.id, { header: structuredClone(session.header), inherited: session.inheritedEventCount, events: structuredClone(events), revision: (old?.revision ?? 0) + 1 })
  }
}
async function setup(t, { goals = false, archives = false, questions = false } = {}) {
  const root = new Context(), fibers = [], services = []
  const base = root.plugin(ctx => { new SessionStore(ctx); new AgentRegistry(ctx); new SessionQueryEngine(ctx); new MemoryPersistence(ctx); new SessionProjectionRegistry(ctx) })
  fibers.push(base); await base.await()
  const ctx = base.ctx
  if (goals || questions) for (const [plugin, config] of [[Registry, undefined], ...(goals ? [[GoalService, { defaultMaxGoalRounds: 3 }]] : []), ...(questions ? [[UserQuestionService, {}]] : [])]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await()
  }
  if (archives) {
    const storage = ctx.plugin(scope => {
      const hub = new Storage(scope)
      scope.effect(() => hub.backend.register('memory', { kv: { async open(descriptor) {
        const tables = Object.fromEntries(descriptor.tables.map(table => [table, {}])); let global = null
        return { async loadAll() { return { tables, global } }, async setGlobal(value) { global = structuredClone(value) },
          async putRecord(table, key, value) { tables[table][key] = structuredClone(value) }, async deleteRecord(table, key) { delete tables[table][key] }, async close() {} }
      } }, async close() {} }))
      const domain = new DomainFacility(scope, { backend: 'memory' }); scope.provide('storageDomain', domain); scope.on('dispose', () => domain.closeAll())
    })
    fibers.push(storage); await storage.await()
    const registry = ctx.plugin(WorkspaceRegistry); fibers.push(registry); await registry.await()
  }
  const directory = mkdtempSync(join(tmpdir(), 'session-dashboard-replay-'))
  t.after(async () => {
    for (const handle of services.toReversed()) await handle.service.close()
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    const canonical = realpathSync(directory), parent = realpathSync(tmpdir())
    assert.equal(dirname(canonical), parent); assert(canonical.startsWith(join(parent, 'session-dashboard-replay-')))
    rmSync(canonical, { recursive: true, force: false })
  })
  const save = async session => {
    const source = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    try { ctx.sessionPersistence.save(session, source.events) } finally { source[Symbol.dispose]() }
  }
  ctx.on('session/flush', save)
  const add = async id => {
    let live
    const owner = ctx.plugin(async scope => {
      const session = scope.sessions.create(SessionId(id))
      const agent = { id: session.id, session, status: 'idle', ctx: scope, options: {}, inbox: { nextTurn: [], nextStep: [] } }
      await scope.agents.register(agent)
      live = { session, agent, status(value) { agent.status = value; agentEvents(scope, agent).emit('agent/status', { agent, status: value }) } }
    })
    fibers.push(owner); await owner.await()
    return { ...live, owner }
  }
  const dashboard = () => {
    const store = new SqliteBoardStore(join(directory, 'dashboard.sqlite'), 'replay-profile')
    const host = createDshHost(ctx), errors = []
    const service = new DashboardService(store, host, error => errors.push(error))
    const handle = { store, host, service, errors,
      mutate: command => service.mutate(mutationFor(service, command)),
      add: async id => { const { binding: inspection } = await service.inspectSession({ sessionId: id }); return service.mutate(mutationFor(service, { type: 'add_card', sessionId: id, projectId: null, inspection })) },
      sync: id => service.mutate(mutationFor(service, { type: 'resync', sessionId: id })),
      card: id => store.read().cards.find(row => row.sessionId === id),
      events: () => store.events(0, 200).events,
    }
    services.push(handle); return handle
  }
  return { ctx, add, save, dashboard }
}
function begin(live, turn = 1, source = { kind: 'user' }) {
  live.status('running')
  live.session.append('turn/start', { turn }); live.session.append('step/start', { turn, step: 1 })
  live.session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: `Prompt ${turn}` }] }), { surfaceOp: 'append' })
}
function end(live, turn = 1, kind = 'completed') {
  live.session.append('step/end', { turn, step: 1 }); live.session.append('turn/end', { turn, reason: { kind } }); live.status('idle')
}

test('durable replay retains completion A while latest capture and queued service show B running', async t => {
  const h = await setup(t), live = await h.add('rapid'), d = h.dashboard()
  begin(live); await d.add('rapid')
  const baseline = d.store.snapshot()
  assert.equal(baseline.cards[0].completionCoverage, 'complete')
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 0)
  // Both changes happen before the service microtask can reconcile its dirty set.
  end(live); begin(live, 2)
  const capture = await d.host.capture('rapid', true)
  assert.equal(capture.observation.runtime.phase, 'running'); assert.equal(capture.source.coverage, 'complete')
  assert.equal(capture.source.completions.length, 1)
  const completion = capture.source.completions[0]
  assert.notEqual(completion.episodeId, capture.observation.runtime.episodeId)
  assert.match(completion.digest, /^[a-f0-9]{64}$/); capture.dispose()
  await d.sync('rapid')
  assert.equal(d.card('rapid').status, 'in_progress'); assert.equal(d.card('rapid').runtime.phase, 'running')
  const events = d.events().filter(event => event.kind === 'completed')
  assert.equal(events.length, 1); assert.equal(events[0].episodeId, completion.episodeId)
  assert.equal(events[0].sourceCursor, completion.cursor); assert.equal(events[0].evidenceDigest, completion.digest)
  const stableId = events[0].eventId
  await d.sync('rapid'); assert.equal(d.events().filter(event => event.kind === 'completed').length, 1)
  assert.equal(d.events().find(event => event.kind === 'completed').eventId, stableId)
})

test('first imported durable multi-round cut is a historical baseline, not new completion triggers', async t => {
  const h = await setup(t), live = await h.add('history')
  begin(live); end(live); begin(live, 2); end(live, 2)
  const d = h.dashboard(); await d.add('history')
  assert.equal(d.card('history').status, 'pending_confirm')
  const baseline = d.events().find(event => event.kind === 'source_baseline')
  assert(baseline); assert.equal(baseline.historical, true)
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 0)
  begin(live, 3); end(live, 3); await d.sync('history')
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 1)
})

test('unload/restart and cold logs recover multiple missed rounds once without granting live review authority', async t => {
  const h = await setup(t), live = await h.add('offline'), first = h.dashboard()
  begin(live); await first.add('offline')
  const membershipId = first.card('offline').membershipId
  const originalScope = first.store.identity()
  await first.service.close()
  end(live); begin(live, 2); end(live, 2)
  await h.save(live.session); await live.owner.dispose()
  assert.equal(h.ctx.sessions.get(live.session.id), undefined)
  const second = h.dashboard(); await second.sync('offline')
  assert.deepEqual(second.store.identity(), originalScope); assert.equal(second.card('offline').membershipId, membershipId)
  const recovered = second.events().filter(event => event.kind === 'completed')
  assert.equal(recovered.length, 2); assert.equal(new Set(recovered.map(event => event.episodeId)).size, 2)
  assert.equal(second.card('offline').runtime.sourceLive, false); assert.equal(second.card('offline').status, 'pending_confirm')
  const card = second.card('offline')
  await assert.rejects(second.mutate({ type: 'review', ...workflowBinding(card), action: 'accept', confirmed: true, destination: { kind: 'stay' } }), error => error.code === 'REVIEW_STALE')
  await second.sync('offline'); assert.equal(second.events().filter(event => event.kind === 'completed').length, 2)
})

test('same Goal spans automatic turns and emits only its final logical completion', async t => {
  const h = await setup(t, { goals: true }), live = await h.add('goal'), d = h.dashboard()
  begin(live)
  const goal = h.ctx.get('goals').create(live.agent, { objective: 'Finish the complete logical goal', maxGoalRounds: 3 })
  await d.add('goal'); end(live)
  await d.sync('goal')
  assert.equal(d.card('goal').runtime.phase, 'continuation_pending')
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 0)
  begin(live, 2, { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 })
  h.ctx.get('goals').complete(live.agent, { id: goal.id, revision: goal.revision })
  const midturn = await d.host.capture('goal', true)
  assert.equal(midturn.source.completions.length, 0); midturn.dispose()
  end(live, 2); await d.sync('goal')
  const events = d.events().filter(event => event.kind === 'completed')
  assert.equal(events.length, 1); assert.equal(events[0].episodeId, d.card('goal').runtime.episodeId)
  assert.equal(d.card('goal').status, 'pending_confirm')
})

test('new completed source commits even when a stale human confirmation is rejected without a receipt', async t => {
  const h = await setup(t), live = await h.add('stale-review'), d = h.dashboard()
  begin(live); await d.add('stale-review'); end(live); await d.sync('stale-review')
  const old = d.card('stale-review'), count = d.events().filter(event => event.kind === 'completed').length
  begin(live, 2); end(live, 2)
  const mutation = mutationFor(d.service, { type: 'review', ...workflowBinding(old), action: 'accept', confirmed: true, destination: { kind: 'stay' } })
  await assert.rejects(d.service.mutate(mutation), error => error.code === 'REVIEW_STALE')
  assert.equal(d.card('stale-review').status, 'pending_confirm'); assert.notEqual(d.card('stale-review').runtime.episodeId, old.runtime.episodeId)
  assert.equal(d.events().filter(event => event.kind === 'completed').length, count + 1)
  assert.equal(d.store.wasCommitted({ requestId: mutation.requestId, digest: 'rejected-command' }), false)
})

test('truncated or replaced source prefixes cause an explicit persistent gap instead of reexecuting history', async t => {
  const h = await setup(t), live = await h.add('rollback'), d = h.dashboard()
  begin(live); await d.add('rollback'); end(live); await d.sync('rollback')
  const before = d.store.snapshot(), record = h.ctx.sessionPersistence.records.get(live.session.id)
  await live.owner.dispose()
  record.events = record.events.slice(0, 2); record.revision += 1
  await d.sync('rollback')
  const after = d.store.snapshot()
  assert.equal(after.cards[0].completionCoverage, 'unavailable'); assert.equal(after.cards[0].sourceCursor, before.cards[0].sourceCursor)
  const gaps = d.events().filter(event => event.kind === 'source_gap')
  assert.equal(gaps.length, 1); assert.match(gaps[0].reason, /来源|前缀|覆盖/)
  await d.sync('rollback')
  assert.equal(d.events().filter(event => event.kind === 'source_gap').length, 1)
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 1)
})

test('temporary durability failure preserves the verified anchor and replays missed completion exactly once after recovery', async t => {
  const h = await setup(t), live = await h.add('temporary-read'), d = h.dashboard()
  begin(live); await d.add(live.session.id)
  const baseline = d.store.snapshot().cards[0]
  assert.equal(baseline.completionCoverage, 'complete')
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  h.ctx.sessions.flush = async () => false
  end(live); await d.sync(live.session.id)
  const unavailable = d.store.snapshot().cards[0]
  assert.equal(unavailable.completionCoverage, 'unavailable'); assert.equal(unavailable.sourceCursor, baseline.sourceCursor)
  assert.equal(d.events().filter(event => event.kind === 'completed').length, 0)
  h.ctx.sessions.flush = flush
  await d.sync(live.session.id)
  const recovered = d.store.snapshot().cards[0]
  assert.equal(recovered.completionCoverage, 'complete'); assert.equal(recovered.sourceIdentity, baseline.sourceIdentity)
  assert.equal(recovered.sourceCursor, live.session.seq)
  const completions = d.events().filter(event => event.kind === 'completed')
  assert.equal(completions.length, 1); assert.equal(completions[0].historical, false)
  await d.sync(live.session.id)
  assert.deepEqual(d.events().filter(event => event.kind === 'completed').map(event => event.eventId), completions.map(event => event.eventId))
})

test('archive then restore before the service queue drains still revokes the persisted cancellation generation', async t => {
  const h = await setup(t, { archives: true }), live = await h.add('archive-aba'), d = h.dashboard()
  begin(live); end(live); await d.add(live.session.id); await d.sync(live.session.id)
  const before = d.store.snapshot(), row = before.cards[0]
  const captured = await d.host.capture(live.session.id, true)
  const sourceVersion = captured.source.archiveVersion
  assert(sourceVersion, 'reliable sources carry the public archive observation incarnation/revision')
  const registry = h.ctx.get('workspaceRegistry')
  const archived = registry.archiveSession(live.session.id)
  const restored = registry.unarchiveSession(live.session.id)
  await Promise.all([archived, restored]); assert.equal(captured.validate(), false); captured.dispose()
  await d.sync(live.session.id)
  const after = d.store.snapshot()
  assert.equal(after.cards[0].hostArchive.state, 'active')
  assert(after.cards[0].cancellationGeneration > row.cancellationGeneration, 'final active must not hide an archive/restore revocation edge')
  const newEvents = d.events().filter(event => event.sequence > before.highWatermark)
  assert(newEvents.some(event => event.kind === 'host_archive'))
  assert.equal(newEvents.filter(event => event.kind === 'completed').length, 0, 'archive changes do not re-complete the same result')
})

function timedQuestion(live, turn = 1) {
  const callId = ToolCallId('continued-question')
  live.session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'ask_user_question', description: 'Ask', parameters: { type: 'object', properties: { timeout: { type: 'number' } } } }] } })
  live.session.append('tool/call', { turn, step: 1, callId, name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Choose"}]}' })
  live.session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: '{"pending":true}' }] }) }, { surfaceOp: 'append' })
  return callId
}

test('actual public timed-question projection keeps continued turn ends out of the completed source until admitted answer work ends', async t => {
  const h = await setup(t, { questions: true }), live = await h.add('continued-question'), d = h.dashboard()
  begin(live); await d.add(live.session.id)
  if (!capabilities.timedQuestions) {
    // rc.1 has no continued question capability. Verify its real legacy call is
    // still a blocking in-turn wait, not an invented cross-turn API.
    live.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('legacy-q'), name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"Choose"}]}' })
    const blocking = await d.host.capture(live.session.id, true)
    assert.equal(blocking.observation.runtime.phase, 'waiting_input'); assert.equal(blocking.source.completions.length, 0); blocking.dispose()
    return
  }
  const callId = timedQuestion(live); end(live)
  const continued = await d.host.capture(live.session.id, true)
  assert.equal(continued.observation.runtime.phase, 'waiting_input'); assert.equal(continued.source.coverage, 'complete'); assert.equal(continued.source.completions.length, 0); continued.dispose()
  await d.sync(live.session.id); assert.equal(d.events().filter(event => event.kind === 'completed').length, 0)
  const reply = createUserMessage({ source: { kind: 'user-question-reply', callId, outcome: 'answered' }, content: [{ type: 'text', text: '{"answers":[{"id":"q","selected":["Continue"]}]}' }] })
  live.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [reply] })
  const queued = await d.host.capture(live.session.id, true)
  assert.equal(queued.source.completions.length, 0); assert.equal(queued.observation.runtime.phase, 'waiting_input'); queued.dispose()
  live.status('running'); live.session.append('turn/start', { turn: 2 })
  live.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  live.session.append('step/start', { turn: 2, step: 1 }); live.session.append('user/message', reply, { surfaceOp: 'append' })
  const admitted = await d.host.capture(live.session.id, true)
  assert.equal(admitted.source.completions.length, 0); assert.equal(admitted.observation.runtime.phase, 'running'); admitted.dispose()
  end(live, 2); await d.sync(live.session.id)
  const completed = d.events().filter(event => event.kind === 'completed')
  assert.equal(completed.length, 1); assert.equal(completed[0].episodeId, d.card(live.session.id).runtime.episodeId)
})

test('missing timed-question projector withdraws complete replay coverage instead of permanently skipping an uncertain completion', async t => {
  const h = await setup(t), live = await h.add('missing-projector'), d = h.dashboard()
  begin(live); await d.add(live.session.id); timedQuestion(live); end(live)
  const capture = await d.host.capture(live.session.id, true)
  if (capabilities.timedQuestions) {
    assert.equal(capture.observation.runtime.sync, 'unknown')
    assert.equal(capture.source.coverage, 'unavailable', 'a missing required projector cannot advance a complete completion-stream cursor')
    assert.equal(capture.source.completions.length, 0); assert.match(capture.source.reason, /投影|问题|验证|覆盖/)
  } else {
    assert.equal(capture.source.coverage, 'complete', 'rc.1 only has the legacy synchronous contract, which must not be emulated as timed')
  }
  capture.dispose()
})

test('unrelated future plugin JSON events retain their raw prefix identity without manufacturing new completion', async t => {
  const h = await setup(t), live = await h.add('future-events'), d = h.dashboard()
  begin(live); await d.add(live.session.id); end(live); await d.sync(live.session.id)
  const before = await d.host.capture(live.session.id, true), prefix = before.source.prefixDigests.at(-1), completed = before.source.completions[0]
  before.dispose()
  for (const payload of [null, 7, 'future-plugin-value', ['nested', { kind: 'custom' }], { phase: 'not-core-status', extension: true }]) live.session.append('future/plugin-event', payload)
  const after = await d.host.capture(live.session.id, true)
  assert.equal(after.source.coverage, 'complete'); assert.equal(after.source.completions.length, 1)
  assert.deepEqual(after.source.completions[0], completed); assert.notEqual(after.source.prefixDigests.at(-1), prefix)
  assert.equal(after.source.throughCursor, live.session.seq); after.dispose()
  await d.sync(live.session.id); assert.equal(d.events().filter(event => event.kind === 'completed').length, 1)
})

test('malformed owned raw lifecycle records are quarantined without overwriting a known human result', async t => {
  const h = await setup(t), live = await h.add('malformed-source'), d = h.dashboard()
  begin(live); await d.add(live.session.id); end(live); await d.sync(live.session.id)
  const card = d.card(live.session.id)
  await d.mutate({ type: 'confirm_review', ...workflowBinding(card) })
  await d.mutate({ type: 'review', ...workflowBinding(d.card(live.session.id)), action: 'accept', confirmed: true, destination: { kind: 'stay' } })
  const accepted = d.card(live.session.id), baseline = d.store.snapshot().cards[0].sourceCursor
  await h.save(live.session); await live.owner.dispose()
  const record = h.ctx.sessionPersistence.records.get(live.session.id)
  record.events.push({ seq: record.events.length, time: Date.now(), type: 'goal/change', data: { kind: 'goal/change', version: 999, operation: 'complete' } }); record.revision += 1
  const capture = await d.host.capture(live.session.id, true)
  assert.equal(capture.observation.runtime.sync, 'unknown'); assert.equal(capture.source?.coverage ?? 'unavailable', 'unavailable'); capture.dispose()
  await d.sync(live.session.id)
  const current = d.card(live.session.id)
  assert.equal(current.status, 'accepted'); assert.deepEqual(current.decision, accepted.decision); assert.equal(current.runtime.sync, 'unknown')
  assert.equal(d.store.snapshot().cards[0].completionCoverage, 'unavailable', 'an unreadable owned source must withdraw public automation coverage')
  assert.equal(d.store.snapshot().cards[0].sourceCursor, baseline)
})

test('replay refuses incomplete/over-budget coverage and never calls it a complete event stream', () => {
  const session = Session.create(SessionId('oversized'))
  const event = { seq: 0, time: 1, type: 'custom/large', data: null }
  const oversized = Array.from({ length: REPLAY_EVENT_LIMIT + 1 }, () => event)
  const replay = replaySource(session.header, 0, oversized, () => [])
  assert.equal(replay.coverage, 'unavailable'); assert.equal(replay.completions.length, 0); assert.match(replay.reason, /容量/)
  const events = [session.append('turn/start', { turn: 1 }), session.append('step/start', { turn: 1, step: 1 })]
  const open = replaySource(session.header, 0, events, () => [])
  assert.equal(open.coverage, 'complete'); assert.equal(open.completions.length, 0); assert.equal(open.throughCursor, 2)
})

// These final scenarios use production AgentLoop + JSONL + Loader/Gateway. Only
// model chunks and latches are seams; the SDK owns every actual turn boundary.
test('production queued turns replay A completion while B is already in its model request', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const firstEntered = latch(), firstRelease = latch(), secondEntered = latch(), secondRelease = latch()
  t.after(() => { firstRelease.release(); secondRelease.release() })
  h.adapter.enqueue(
    async function* (request) { firstEntered.release(); await firstRelease.wait(request.signal); yield* textResponse('A complete') },
    async function* (request) { secondEntered.release(); await secondRelease.wait(request.signal); yield* textResponse('B complete') },
  )
  const agent = await h.create('production-rapid'); await h.add(agent.id)
  prompt(agent, 'A'); await firstEntered.promise; prompt(agent, 'B queued behind A')
  firstRelease.release(); await secondEntered.promise
  const observer = createDshHost(h.ctx)
  try {
    const capture = await observer.capture(agent.id, true)
    assert.equal(capture.observation.runtime.phase, 'running'); assert.equal(capture.source.coverage, 'complete'); assert.equal(capture.source.completions.length, 1)
    const firstEpisode = capture.source.completions[0].episodeId
    assert.notEqual(firstEpisode, capture.observation.runtime.episodeId); capture.dispose()
    await h.sync(agent.id)
    const snapshot = await h.ctx.get('sessionDashboardExtensions').snapshot({ apiVersion: 2 }, () => {})
    const events = h.ctx.get('sessionDashboardExtensions').events({ apiVersion: 2, after: 0, limit: 200 }, () => {})
    assert.equal(snapshot.cards[0].phase, 'running'); assert.equal(events.events.filter(event => event.kind === 'completed').length, 1)
    assert.equal(events.events.find(event => event.kind === 'completed').episodeId, firstEpisode)
    secondRelease.release(); await agent.whenIdle(); await h.sync(agent.id)
    const final = h.ctx.get('sessionDashboardExtensions').events({ apiVersion: 2, after: 0, limit: 200 }, () => {})
    assert.equal(final.events.filter(event => event.kind === 'completed').length, 2)
  } finally { observer.close() }
})

test('production dashboard unload plus host restart recovers two fsynced JSONL rounds without model restart', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('production-offline'); await h.add(agent.id)
  const original = await h.ctx.get('sessionDashboardExtensions').snapshot({ apiVersion: 2 }, () => {})
  await h.entry.fiber.dispose()
  assert.equal(h.ctx.get('sessionDashboard'), undefined)
  h.adapter.enqueue(textResponse('Offline A'), textResponse('Offline B'))
  prompt(agent, 'Offline A'); await agent.whenIdle(); prompt(agent, 'Offline B'); await agent.whenIdle()
  const events = await h.readEvents(agent.id)
  assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2)
  await h.close()
  const restarted = await workspace.start(); await restarted.sync(agent.id)
  const snapshot = await restarted.ctx.get('sessionDashboardExtensions').snapshot({ apiVersion: 2 }, () => {})
  assert.deepEqual(snapshot.handshake.scope, original.handshake.scope)
  assert.equal(snapshot.cards[0].membershipId, original.cards[0].membershipId)
  assert.equal(snapshot.cards[0].sourceLive, false); assert.equal(snapshot.cards[0].completionCoverage, 'complete')
  const recovered = restarted.ctx.get('sessionDashboardExtensions').events({ apiVersion: 2, after: original.highWatermark, limit: 200 }, () => {})
  assert.equal(recovered.events.filter(event => event.kind === 'completed').length, 2)
  assert.equal(restarted.adapter.requests.length, 0); assert.equal(restarted.ctx.agents.list().length, 0)
  await restarted.sync(agent.id)
  const repeated = restarted.ctx.get('sessionDashboardExtensions').events({ apiVersion: 2, after: original.highWatermark, limit: 200 }, () => {})
  assert.deepEqual(repeated.events.filter(event => event.kind === 'completed').map(event => event.eventId), recovered.events.filter(event => event.kind === 'completed').map(event => event.eventId))
})

test('unchanged durable revision reuses replay evidence without reopening the log', async t => {
  const h = await setup(t), live = await h.add('replay-cache'), d = h.dashboard()
  begin(live); end(live)
  await d.add('replay-cache')
  await d.sync('replay-cache')
  const persistence = h.ctx.sessionPersistence, before = structuredClone(persistence.counts)
  await d.sync('replay-cache')
  const after = persistence.counts
  assert.equal(after.open, before.open, 'a cached replay does not reopen the durable log')
  assert.equal(after.read, before.read, 'a cached replay does not reread the durable log')
  assert.equal(after.flush, before.flush, 'a cached replay does not flush an unchanged cut')
  assert(after.stat > before.stat, 'the cheap stat revision still guards external rewrites')
  assert.equal(d.card('replay-cache').runtime.sync, 'synced')
})

test('a full reconcile reuses the live fold instead of rereading the prefix', async t => {
  const h = await setup(t), live = await h.add('no-forced-replay'), d = h.dashboard()
  begin(live); end(live)
  await d.add('no-forced-replay'); await d.sync('no-forced-replay')
  const persistence = h.ctx.sessionPersistence, before = persistence.reads.length
  begin(live, 2); end(live, 2)
  await d.mutate({ type: 'resync', sessionId: null })
  const freshReads = persistence.reads.slice(before)
  assert.ok(freshReads.length > 0, 'the resync must observe the new tail')
  assert.equal(freshReads.some(([offset, length]) => offset === 0 && length === undefined), false, 'a full reconcile must not reread the whole prefix')
  assert.equal(d.card('no-forced-replay').runtime.phase, 'completed')
})

test('live replay extends from in-memory events without opening the durable log', async t => {
  const h = await setup(t), live = await h.add('live-memory'), d = h.dashboard()
  begin(live); await d.add('live-memory')
  const opens = h.ctx.sessionPersistence.counts.open, reads = h.ctx.sessionPersistence.counts.read
  live.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Still running' }] }), { surfaceOp: 'append' })
  await d.sync('live-memory')
  assert.equal(h.ctx.sessionPersistence.counts.open, opens, 'live replay must not open the durable log')
  assert.equal(h.ctx.sessionPersistence.counts.read, reads, 'live replay must not reread the durable log')
  assert.equal(d.card('live-memory').runtime.phase, 'running')
})

test('unchanged cold revision reuses the cold observation without reopening the log', async t => {
  const h = await setup(t), live = await h.add('cold-cache')
  begin(live); end(live)
  await h.save(live.session); await live.owner.dispose()
  const d = h.dashboard()
  const first = await d.host.capture('cold-cache', true)
  first.dispose()
  const counts = h.ctx.sessionPersistence.counts, before = structuredClone(counts)
  const second = await d.host.capture('cold-cache', true)
  second.dispose()
  assert.equal(counts.open, before.open, 'an unchanged cold revision does not reopen the durable log')
  assert.equal(counts.read, before.read, 'an unchanged cold revision does not reread the durable log')
  assert.equal(second.observation.runtime.sync, 'synced')
  assert.equal(second.source.coverage, 'complete')
})

test('incremental replay fold matches a full replay exactly', () => {
  const session = Session.create(SessionId('incremental'))
  const turns = []
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Prompt ${turn}` }] }), { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turns.push(session.snapshotEvents())
  }
  const events = session.snapshotEvents()
  const full = replaySource(session.header, 0, events, () => [])
  assert.equal(full.coverage, 'complete')
  assert.ok(full.completions.length > 0, 'the fixture must exercise completion evidence')
  const fold = new ReplayFold(session.header, 0, () => [])
  let value
  for (const cut of [2, 7, 12, events.length]) value = fold.append(events.slice(fold.cursor, cut), cursor => events.slice(0, cursor))
  assert.deepEqual(value, full)
  assert.equal(fold.eventCount, events.length)
})

test('repeated live captures extend one fold without changing the evidence cut', async t => {
  const h = await setup(t), live = await h.add('incremental-live'), d = h.dashboard()
  begin(live); end(live)
  await d.add('incremental-live'); await d.sync('incremental-live')
  for (let turn = 2; turn <= 4; turn += 1) { begin(live, turn); end(live, turn); await d.sync('incremental-live') }
  const capture = await d.host.capture('incremental-live', true)
  try {
    const record = h.ctx.sessionPersistence.records.get('incremental-live')
    const full = replaySource(live.session.header, 0, record.events, () => [])
    assert.equal(capture.source.coverage, 'complete')
    assert.equal(capture.source.throughCursor, record.events.length)
    assert.deepEqual(capture.source.prefixDigests, full.prefixDigests)
    assert.deepEqual(capture.source.completions, full.completions)
  } finally { capture.dispose() }
})

test('streaming replay byte accounting is byte-for-byte equivalent and aborts at the limit', () => {
  const events = [{ seq: 0, type: 'a', data: { text: 'x' } }, undefined, { seq: 1, type: 'b', data: {} }, { seq: 2, type: 'c', data: null }]
  const actual = Buffer.byteLength(JSON.stringify(events), 'utf8')
  assert.equal(replayByteLength(events, REPLAY_BYTES_LIMIT), actual)
  assert.equal(replayByteLength(events, actual), actual)
  assert.equal(replayByteLength(events, actual - 1), null)
  const large = Array.from({ length: 8 }, (_, index) => ({ seq: index, type: 'x', data: 'y'.repeat(64) }))
  const size = Buffer.byteLength(JSON.stringify(large), 'utf8')
  assert.equal(replayByteLength(large, size), size)
  assert.equal(replayByteLength(large, size - 1), null)
})

test('replay skips timed-question projection when the journal never observed one', () => {
  const session = Session.create(SessionId('no-timed-question'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  let projections = 0
  const replay = replaySource(session.header, 0, session.snapshotEvents(), () => { projections += 1; return [] })
  assert.equal(projections, 0, 'ordinary logs never restore the whole prefix for a question projection')
  assert.equal(replay.coverage, 'complete')
})
