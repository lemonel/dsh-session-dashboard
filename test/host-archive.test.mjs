import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionStore, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionPersistence, SessionPersistenceNotFoundError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { WorkspaceRegistry, WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createDshHost } from '../lib/backend/dsh-host.js'

/** In-memory test boundary implements public persistence/storage backend contracts;
 * archive semantics, activity admission, domain events and service lifecycle are
 * the actual selected SDK implementations, not a dashboard-side simulation. */
class MemoryPersistence extends SessionPersistence {
  records = new Map()
  failure = null
  async create() { throw new Error('Read-only dashboard fixture') }
  async flush() {}
  async stat(id) {
    if (this.failure) throw this.failure
    const record = this.records.get(id)
    return record && { header: structuredClone(record.header), revision: SessionPersistenceRevision(`${record.revision}`), eventCount: record.events.length }
  }
  async list() {
    if (this.failure) throw this.failure
    return Promise.all([...this.records.keys()].map(id => this.stat(id)))
  }
  async open(id, access) {
    if (this.failure) throw this.failure
    assert.equal(access, 'read', 'archive facts must never acquire session write ownership')
    const record = this.records.get(id)
    if (!record) throw new SessionPersistenceNotFoundError(id)
    const close = async () => {}
    return { id, access, header: structuredClone(record.header), inheritedEventCount: SessionLogOffset(record.inherited),
      read: async (offset = 0, length) => ({ events: structuredClone(record.events.slice(offset, length === undefined ? undefined : offset + length)), eventState: 'independent' }),
      close, [Symbol.asyncDispose]: close }
  }
  save(session, events) {
    const revision = (this.records.get(session.id)?.revision ?? 0) + 1
    this.records.set(session.id, { header: structuredClone(session.header), inherited: session.inheritedEventCount, events: structuredClone(events), revision })
  }
}
function memoryBackend() {
  const units = new Map()
  return { kv: { async open(descriptor) {
    const previous = units.get(descriptor.name)
    const state = previous ?? { global: null, tables: Object.fromEntries(descriptor.tables.map(table => [table, {}])) }
    units.set(descriptor.name, state)
    return { async loadAll() { return structuredClone(state) },
      async putRecord(table, key, value) { state.tables[table][key] = structuredClone(value) },
      async deleteRecord(table, key) { delete state.tables[table][key] },
      async setGlobal(value) { state.global = structuredClone(value) }, async close() {} }
  } }, async close() {} }
}
async function setup(t, { registry = true } = {}) {
  const root = new Context(), fibers = []
  const base = root.plugin(ctx => {
    new SessionStore(ctx); new AgentRegistry(ctx); new SessionQueryEngine(ctx); new MemoryPersistence(ctx); new SessionProjectionRegistry(ctx)
    const storage = new Storage(ctx)
    ctx.effect(() => storage.backend.register('memory', memoryBackend()))
    const domain = new DomainFacility(ctx, { backend: 'memory' })
    ctx.provide('storageDomain', domain)
    ctx.on('dispose', () => domain.closeAll())
  })
  fibers.push(base); await base.await()
  const ctx = base.ctx
  let registryFiber = null
  const mountRegistry = async () => {
    registryFiber = ctx.plugin(WorkspaceRegistry); fibers.push(registryFiber); await registryFiber.await()
    // Settle the public dependency lifecycle, not wall-clock polling.
    await Promise.resolve(); await Promise.resolve()
    return registryFiber
  }
  if (registry) await mountRegistry()
  const host = createDshHost(ctx)
  t.after(async () => { host.close(); for (const fiber of fibers.toReversed()) await fiber.dispose() })
  const detachedEvents = new WeakMap()
  const save = async session => {
    const events = detachedEvents.get(session)
    if (events) { ctx.sessionPersistence.save(session, events); return }
    const source = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    try { ctx.sessionPersistence.save(session, source.events) } finally { source[Symbol.dispose]() }
  }
  ctx.on('session/flush', save)
  let cancelRequests = 0
  const add = async (id, meta = {}, cold = false) => {
    const branded = SessionId(id)
    const header = { ...Session.create(branded).header, ...meta }
    const session = cold ? Session.create(branded, [], header) : ctx.sessions.create(branded, { meta })
    if (cold) {
      const events = [], append = session.append.bind(session)
      session.append = (...args) => { const event = append(...args); events.push(event); return event }
      detachedEvents.set(session, events)
      ctx.sessionPersistence.save(session, events)
      return { session, agent: null }
    }
    const agent = { id: session.id, session, status: 'idle', ctx, options: {}, inbox: { nextTurn: [], nextStep: [] }, cancel() { cancelRequests += 1 } }
    await ctx.agents.register(agent)
    return { session, agent, status(value) { agent.status = value; agentEvents(ctx, agent).emit('agent/status', { agent, status: value }) } }
  }
  return { ctx, host, add, save, mountRegistry, get registryFiber() { return registryFiber }, get cancelRequests() { return cancelRequests } }
}
const query = (extra = {}) => ({ search: '', offset: 0, limit: 2, membership: 'all', hostArchive: 'all', generation: null, ...extra })
function finish(live) {
  live.status('running')
  live.session.append('turn/start', { turn: 1 }); live.session.append('step/start', { turn: 1, step: 1 })
  live.session.append('step/end', { turn: 1, step: 1 }); live.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  live.status('idle')
}

test('real SDK archive facts fence review without changing completed lifecycle or resuming anything', async t => {
  const h = await setup(t), live = await h.add('completed')
  finish(live)
  const active = await h.host.capture(live.session.id)
  assert.equal(active.observation.hostArchive.state, 'active'); assert.equal(active.validate(), true)
  const runtime = structuredClone(active.observation.runtime)
  await h.ctx.get('workspaceRegistry').archiveSession(live.session.id)
  assert.equal(active.validate(), false)
  const archived = await h.host.capture(live.session.id)
  assert.equal(archived.observation.hostArchive.state, 'archived'); assert.equal(archived.validate(), true)
  assert.deepEqual(archived.observation.runtime, runtime, 'archive marker does not fabricate completion, interrupt or acceptance')
  await h.ctx.get('workspaceRegistry').unarchiveSession(live.session.id)
  assert.equal(archived.validate(), false)
  const restored = await h.host.capture(live.session.id)
  assert.equal(restored.observation.hostArchive.state, 'active'); assert.deepEqual(restored.observation.runtime, runtime)
  assert.equal(h.cancelRequests, 0)
  for (const capture of [active, archived, restored]) capture.dispose()
})

test('archive then restore ABA invalidates a held confirmation even with the same final boolean', async t => {
  const h = await setup(t), live = await h.add('aba')
  const before = await h.host.capture(live.session.id)
  await h.ctx.get('workspaceRegistry').archiveSession(live.session.id)
  await h.ctx.get('workspaceRegistry').unarchiveSession(live.session.id)
  assert.equal(before.observation.hostArchive.state, 'active'); assert.equal(before.validate(), false)
  const fresh = await h.host.capture(live.session.id)
  assert.equal(fresh.observation.hostArchive.state, 'active'); assert.equal(fresh.validate(), true)
  before.dispose(); fresh.dispose()
})

test('public committed workspace events notify and payload alone is not trusted archive truth', async t => {
  const h = await setup(t), live = await h.add('notify')
  const capture = await h.host.capture(live.session.id); capture.dispose()
  const changes = []
  const stop = h.host.subscribe(id => changes.push(id))
  await h.ctx.get('workspaceRegistry').archiveSession(live.session.id)
  assert(changes.includes('notify'))
  h.ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [] } })
  const actual = await h.host.capture(live.session.id)
  assert.equal(actual.observation.hostArchive.state, 'archived', 'read the registry, never the notification payload')
  stop(); actual.dispose()
})

test('registry unloading and replacement invalidate exact source and report unsupported in the gap', async t => {
  const h = await setup(t), live = await h.add('reload')
  const original = await h.host.capture(live.session.id)
  await h.registryFiber.dispose()
  assert.equal(original.validate(), false)
  const unavailable = await h.host.capture(live.session.id)
  assert.equal(unavailable.observation.hostArchive.state, 'unsupported'); assert.match(unavailable.observation.hostArchive.reason, /公开|归档/)
  await h.mountRegistry()
  assert.equal(unavailable.validate(), false)
  const restored = await h.host.capture(live.session.id)
  assert.equal(restored.observation.hostArchive.state, 'active'); assert.equal(restored.validate(), true)
  for (const capture of [original, unavailable, restored]) capture.dispose()
})

test('membership and host archive conditions apply before total and pagination across cold and fork candidates', async t => {
  const h = await setup(t)
  const a = await h.add('a', { createdAt: 50, cwd: '/a' })
  await h.add('b', { createdAt: 40, cwd: '/b', parentSession: a.session.id })
  await h.add('c', { createdAt: 30 }, true)
  await h.add('d', { createdAt: 20 })
  await h.add('e', { createdAt: 10 }, true)
  await h.add('subagent', { createdAt: 60, origin: 'subagent', delegationDepth: 1, parentSession: a.session.id })
  await h.ctx.get('workspaceRegistry').archiveSession(SessionId('d'))
  const members = new Set(['a', 'b'])
  const untracked = await h.host.list(query({ membership: 'untracked', hostArchive: 'active' }), members)
  assert.deepEqual(untracked.items.map(row => row.sessionId), ['c', 'e']); assert.equal(untracked.total, 2); assert.equal(untracked.nextOffset, null)
  const archived = await h.host.list(query({ membership: 'untracked', hostArchive: 'archived' }), members)
  assert.deepEqual(archived.items.map(row => row.sessionId), ['d']); assert.equal(archived.items[0].hostArchive.state, 'archived')
  const tracked = await h.host.list(query({ membership: 'tracked', hostArchive: 'all' }), members)
  assert.deepEqual(tracked.items.map(row => row.sessionId), ['a', 'b']); assert.equal(tracked.total, 2)
  const first = await h.host.list(query({ limit: 1, membership: 'untracked', hostArchive: 'all' }), members)
  const second = await h.host.list(query({ offset: first.nextOffset, limit: 1, membership: 'untracked', hostArchive: 'all', generation: first.generation }), members)
  assert.deepEqual(first.items.map(row => row.sessionId), ['c']); assert.deepEqual(second.items.map(row => row.sessionId), ['d'])
  assert.equal(first.generation, second.generation); assert.equal(first.total, 3)
  await assert.rejects(h.host.capture('subagent'), error => error.code === 'FORBIDDEN')
})

test('candidate generation rejects changed membership, condition, cold title, archive ABA and corpus identity', async t => {
  const h = await setup(t)
  await h.add('a', { createdAt: 30 }); const cold = await h.add('b', { createdAt: 20 }, true)
  await h.add('c', { createdAt: 10 })
  const members = new Set(['a'])
  const first = await h.host.list(query({ limit: 1, membership: 'untracked' }), members)
  const next = extra => query({ limit: 1, offset: 1, membership: 'untracked', generation: first.generation, ...extra })
  await assert.rejects(h.host.list(next(), new Set(['a', 'b'])), error => error.code === 'CONFLICT')
  await assert.rejects(h.host.list(next({ membership: 'all' }), members), error => error.code === 'CONFLICT')
  cold.session.append('session/title', { title: 'New cold title', messageSeqs: [], source: { kind: 'user' } })
  await h.save(cold.session)
  await assert.rejects(h.host.list(next(), members), error => error.code === 'CONFLICT')
  const refreshed = await h.host.list(query({ limit: 1, membership: 'untracked' }), members)
  await h.ctx.get('workspaceRegistry').archiveSession(SessionId('c')); await h.ctx.get('workspaceRegistry').unarchiveSession(SessionId('c'))
  await assert.rejects(h.host.list(next({ generation: refreshed.generation }), members), error => error.code === 'CONFLICT')
  const again = await h.host.list(query({ limit: 1, membership: 'untracked' }), members)
  await h.add('d', { createdAt: 5 })
  await assert.rejects(h.host.list(next({ generation: again.generation }), members), error => error.code === 'CONFLICT')
})

test('missing member source and unknown/unsupported archive conditions fail closed, while all returns explicit facts', async t => {
  const h = await setup(t, { registry: false })
  await h.add('a')
  await assert.rejects(h.host.list(query({ membership: 'untracked' })), error => error.code === 'UNAVAILABLE')
  await assert.rejects(h.host.list(query({ hostArchive: 'active' })), error => error.code === 'UNAVAILABLE')
  const all = await h.host.list(query())
  assert.equal(all.total, 1); assert.equal(all.items[0].hostArchive.state, 'unsupported')
  const fake = h.ctx.plugin(ctx => { ctx.provide('workspaceRegistry', { get archivedSessionIds() { throw new Error('archive storage denied') } }) })
  await fake.await(); t.after(() => fake.dispose())
  await assert.rejects(h.host.list(query({ hostArchive: 'active' })), error => error.code === 'UNAVAILABLE' && /archive storage denied/.test(error.message))
  const unknown = await h.host.list(query())
  assert.equal(unknown.items[0].hostArchive.state, 'unknown')
  const capture = await h.host.capture('a')
  assert.equal(capture.observation.hostArchive.state, 'unknown'); capture.dispose()
})

test('candidate read races retry a full coherent corpus instead of paginating mixed archive cuts', async t => {
  const h = await setup(t)
  await h.add('a', { createdAt: 30 }); await h.add('b', { createdAt: 20 }); await h.add('c', { createdAt: 10 })
  const original = h.ctx.sessionQuery.readTitle.bind(h.ctx.sessionQuery)
  let changed = false
  h.ctx.sessionQuery.readTitle = async (...args) => {
    if (!changed) { changed = true; await h.ctx.get('workspaceRegistry').archiveSession(SessionId('a')) }
    return original(...args)
  }
  const page = await h.host.list(query({ hostArchive: 'active', limit: 1 }))
  assert.equal(page.total, 2); assert.deepEqual(page.items.map(row => row.sessionId), ['b']); assert.equal(page.nextOffset, 1)
  assert.equal(page.items[0].hostArchive.state, 'active')
})

test('missing persistence cannot masquerade as a complete live-only candidate corpus', async t => {
  const h = await setup(t), live = await h.add('a')
  h.ctx.sessionPersistence.failure = new Error('history listing denied')
  await assert.rejects(h.host.list(query()), error => error.code === 'UNAVAILABLE' && /history listing denied/.test(error.message))
  h.ctx.sessionPersistence.failure = null
  const originalGet = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name, ...rest) => name === 'sessionPersistence' ? undefined : originalGet(name, ...rest)
  await assert.rejects(h.host.list(query()), error => error.code === 'UNAVAILABLE' && /完整/.test(error.message))
  assert.equal(h.ctx.sessions.get(live.session.id), live.session)
})

test('actual SDK active archive admission and explicit stop request are not fabricated by observation', async t => {
  const h = await setup(t), live = await h.add('running')
  live.status('running'); live.session.append('turn/start', { turn: 1 }); live.session.append('step/start', { turn: 1, step: 1 })
  await assert.rejects(h.ctx.get('workspaceRegistry').archiveSession(live.session.id), WorkspaceActiveSessionError)
  const stillActive = await h.host.capture(live.session.id)
  assert.equal(stillActive.observation.hostArchive.state, 'active'); assert.equal(h.cancelRequests, 0)
  await h.ctx.get('workspaceRegistry').archiveSession(live.session.id, { stopActivity: true })
  assert.equal(stillActive.validate(), false); assert.equal(h.cancelRequests, 1)
  const pendingStop = await h.host.capture(live.session.id)
  assert.equal(pendingStop.observation.hostArchive.state, 'archived'); assert.equal(pendingStop.observation.runtime.phase, 'running', 'a stop request is not settlement')
  const seq = live.session.seq
  await h.ctx.get('workspaceRegistry').unarchiveSession(live.session.id)
  const restored = await h.host.capture(live.session.id)
  assert.equal(restored.observation.hostArchive.state, 'active'); assert.equal(live.session.seq, seq); assert.equal(h.cancelRequests, 1)
  for (const capture of [stillActive, pendingStop, restored]) capture.dispose()
})
