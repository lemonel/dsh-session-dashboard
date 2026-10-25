import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { GoalService } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { snapshotSchema } from '../../lib/shared/model.js'
import { candidatesPageSchema, sessionInspectionSchema, navigationResultSchema, historyPageSchema } from '../../lib/shared/commands.js'
import { handshakeSchema, publicSnapshotSchema, eventPageSchema } from '../../lib/shared/extension.js'
import { workflowBinding } from '../helpers.mjs'
import { browserPeer, mountGatewayPrerequisites } from './sdk.mjs'
export { assertLocalSdk } from './sdk.mjs'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const agentOptions = { provider: 'dashboard-execution-test', model: 'scripted-no-network' }

export function denyNetwork(t) {
  const attempted = []
  const deny = api => (...args) => { attempted.push(api); throw new Error(`Execution integration test forbids network: ${api}`) }
  for (const [object, key, api] of [
    [globalThis, 'fetch', 'fetch'], [http, 'request', 'http.request'], [http, 'get', 'http.get'],
    [https, 'request', 'https.request'], [https, 'get', 'https.get'],
    [net, 'connect', 'net.connect'], [net, 'createConnection', 'net.createConnection'], [tls, 'connect', 'tls.connect'],
  ]) t.mock.method(object, key, deny(api))
  t.after(() => assert.deepEqual(attempted, [], 'no network API may be attempted, even if a caller contains the error'))
}

export function latch() {
  const { promise, resolve: release } = Promise.withResolvers()
  return { promise, release, async wait(signal) {
    signal?.throwIfAborted()
    if (!signal) return promise
    let onAbort
    try {
      await Promise.race([promise, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })])
      signal.throwIfAborted()
    } finally { signal.removeEventListener('abort', onAbort) }
  } }
}

export function textResponse(text = 'Deterministic result') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
export function toolResponse(name, args = {}, callId = randomUUID()) {
  const block = { type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export class ScriptedAdapter extends LlmAdapter {
  requests = []
  plans = []
  enqueue(...plans) { this.plans.push(...plans) }
  async *stream(options) {
    this.requests.push(options)
    assert.equal(options.provider, agentOptions.provider)
    assert.equal(options.model, agentOptions.model)
    assert(options.sessionId, 'request must have been assembled by the production AgentLoop')
    const plan = this.plans.shift()
    assert(plan, `Unexpected model request #${this.requests.length}; no external provider exists`)
    if (typeof plan === 'function') yield* plan(options)
    else yield* plan
  }
}

async function removeTemp(root) {
  // Verify the exact generated target before recursive removal, never a profile,
  // checkout, cwd, environment-derived directory, or computed empty fallback.
  const canonical = await realpath(root)
  const expectedParent = await realpath(tmpdir())
  assert.equal(dirname(canonical), expectedParent)
  assert(canonical.startsWith(join(expectedParent, 'session-dashboard-execution-')))
  await rm(canonical, { recursive: true, force: false })
}

/** Temp workspace owns both real JSONL logs and the dashboard SQLite database. */
export async function executionWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'session-dashboard-execution-'))
  const fixtures = []
  t.after(async () => {
    for (const fixture of fixtures.toReversed()) await fixture.close()
    await removeTemp(root)
  })
  return {
    root,
    async start(options = {}) {
      const fixture = await executionHost(root, options)
      fixtures.push(fixture)
      return fixture
    },
  }
}

async function executionHost(root, { questions = false, approval = false, goals = false, automaticGoals = false } = {}) {
  const top = new Context()
  const owner = top.plugin(() => {})
  await owner.await()
  const scope = owner.ctx
  const ctx = top
  const handles = []
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const handle of handles.toReversed()) await handle.dispose()
    if (ctx.get('agents')) assert.equal(ctx.agents.list().length, 0, 'all real AgentLoop handles must be detached')
    await owner.dispose()
    for (const key of ['agentLoop', 'sessionDashboard', 'sessionPersistence', 'sessions', 'agents', 'loader']) {
      assert.equal(ctx.get(key), undefined, `${key} must be completely released with the isolated owner`)
    }
  }
  try {
    await mountAgentLoopTestDependencies(scope, { tools: { mode: 'native' } })
    await scope.plugin(JsonlPersistence.default ?? JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await scope.plugin(SessionQueryEngine)
    await scope.plugin(Registry)
    await mountGatewayPrerequisites(scope)
    await scope.plugin(Gateway, {})
    if (questions) await scope.plugin(UserQuestionService, {})
    if (approval) await scope.plugin(ApprovalService, { policy: 'ask' })
    if (goals) await scope.plugin(GoalService, { defaultMaxGoalRounds: 5 })
    const adapter = new ScriptedAdapter()
    scope.get('llm').registerAdapter([agentOptions.provider], adapter)
    await scope.plugin(AgentLoop, { agents: [] })
    if (automaticGoals) await scope.plugin(GoalRoundDriver)
    assert(ctx.agentLoop, 'the actual installed AgentLoop service must be mounted')
    const { peer } = browserPeer(scope, 'isolated-human-operator')
    await scope.plugin(Loader, { baseUrl: new URL('../../package.json', import.meta.url).href })
    // Import the actual package export using the installed Cordis Loader. This is
    // not a direct call to apply(), remote construction, or generated-source patch.
    // Match dsh's profile launch contract; shell-tool env overlays are not plugin globals.
    scope.reflect.provide('profileContext', { dir: root, name: 'execution-test' })
    const entryId = await ctx.loader.create({ name: '@hsx/dsh-session-dashboard', config: { dataDir: join(root, 'dashboard') } })
    await ctx.loader.await()
    const entry = ctx.loader.resolve(entryId)
    assert(entry.fiber, 'Loader must create the plugin entry fiber')
    await entry.fiber.await()
    assert(ctx.get('sessionDashboard'), 'built backend export must register its service')
    const invoke = async (method, args = {}) => {
      const result = await ctx.typertGateway.invoke({ namespace: 'sessionDashboard', method, args, peer })
      const schemas = { snapshot: snapshotSchema, mutate: snapshotSchema, candidates: candidatesPageSchema,
        inspectSession: sessionInspectionSchema, history: historyPageSchema, navigation: navigationResultSchema,
        handshake: handshakeSchema, extensionSnapshot: publicSnapshotSchema, extensionEvents: eventPageSchema }
      return schemas[method].parse(result)
    }
    // Negotiate once per test client. Never silently rebind an old envelope after reload.
    const handshake = await invoke('handshake')
    const envelope = (command, requestId = randomUUID()) => ({ apiVersion: 2, serviceId: handshake.serviceId, requestId, command })
    const submit = mutation => invoke('mutate', { mutation })
    const mutate = (command, requestId = randomUUID()) => submit(envelope(command, requestId))
    const snapshot = () => invoke('snapshot')
    const sync = sessionId => mutate({ type: 'resync', sessionId })
    const card = async sessionId => (await snapshot()).board.cards.find(value => value.sessionId === sessionId)
    const create = async (id, resume = false) => {
      const handle = resume ? await scope.get('agents').resume({ resumeSessionId: SessionId(id), agentOptions })
        : await scope.get('agents').create({ sessionId: SessionId(id), agentOptions, meta: { cwd: root } })
      handles.push(handle)
      assert.equal(ctx.agents.get(handle.agent.id), handle.agent)
      assert.equal(ctx.sessions.get(handle.agent.id), handle.agent.session)
      return handle.agent
    }
    const inspect = sessionId => invoke('inspectSession', { query: { sessionId } })
    const add = async (sessionId, projectId = null) => {
      const { binding: inspection } = await inspect(sessionId)
      return mutate({ type: 'add_card', sessionId, projectId, inspection })
    }
    const confirm = async sessionId => mutate({ type: 'confirm_review', ...workflowBinding(await card(sessionId)) })
    const review = async (sessionId, action = 'accept', extra = {}) => {
      // A finished round is 待确认 until the human opens it; reviewing implies that.
      const parked = await card(sessionId)
      if (parked.status === 'pending_confirm' && parked.runtime.sync === 'synced' && parked.runtime.sourceLive && parked.runtime.phase === 'completed') {
        await mutate({ type: 'confirm_review', ...workflowBinding(parked) })
      }
      const checked = workflowBinding(await card(sessionId))
      return mutate({ type: 'review', ...checked, action, confirmed: true, destination: { kind: 'stay' }, ...extra })
    }
    const history = (checked, after) => invoke('history', { query: { sessionId: checked.sessionId, membershipId: checked.membershipId, limit: 100, ...(after === undefined ? {} : { after }) } })
    const readEvents = async sessionId => {
      const live = ctx.sessions.get(SessionId(sessionId))
      if (live) assert.equal(await ctx.sessions.flush(live), true, 'actual loop owns session checkpoint')
      const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try { return (await handle.read()).events } finally { await handle.close() }
    }
    const registerTool = (name, execute) => scope.get('tools').register({
      name, description: 'Isolated deterministic integration fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute,
    })
    const on = (...args) => scope.on(...args)
    return { root, ctx, adapter, peer, entry, close, create, invoke, handshake, envelope, submit, mutate, snapshot, sync, card, inspect, add, confirm, review, history, readEvents, registerTool, on }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host setup and cleanup failed') }
    throw error
  }
}

export const userMessage = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
export const prompt = (agent, text = 'Perform the isolated integration task') => agent.followup(userMessage(text))
export const eventsOf = (events, type) => events.filter(event => event.type === type)
export function assertRunning(card, phase = 'running') {
  assert.equal(card.status, 'in_progress')
  assert.equal(card.runtime.sync, 'synced', card.runtime.explanation ?? 'runtime must be authoritative')
  assert.equal(card.runtime.phase, phase)
  assert.equal(card.reviewAt, null)
  assert.equal(card.acceptedAt, null)
}
export function assertPending(card) {
  // A finished round parks in 待确认 until the human opens it.
  assert.equal(card.status, 'pending_confirm')
  assert.equal(card.runtime.sync, 'synced', card.runtime.explanation ?? 'runtime must be authoritative')
  assert.equal(card.runtime.phase, 'completed')
  assert.equal(card.runtime.sourceLive, true)
  assert(card.reviewAt !== null)
  assert.equal(card.acceptedAt, null)
}
