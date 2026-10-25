import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { SqliteBoardStore, digestCommand, EVENT_RETENTION_MS } from '../lib/backend/store.js'
import { DashboardService } from '../lib/backend/service.js'
import { DashboardExtensions } from '../lib/backend/extensions.js'
import { SessionDashboardRemote } from '../lib/backend/remote.js'
import { DashboardError } from '../lib/shared/commands.js'
import { unknownRuntime } from '../lib/shared/model.js'
import { handshakeSchema, publicSnapshotSchema, eventPageSchema } from '../lib/shared/extension.js'
import { TYPERT } from '../lib/backend/typert.host.js'
import { browserPeer, mountGatewayPrerequisites } from './tools/sdk.mjs'

const absentHost = () => ({ async capture() { throw new Error('No host calls expected in empty-board public contract test') }, async list() { return { items: [], total: 0, nextOffset: null, generation: 'empty' } }, subscribe() { return () => {} }, close() {} })
function card(id = 'card', phase = 'completed') {
  const runtime = { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase, episodeId: 'turn:1', episodeOrder: 1, startedAt: 100, endedAt: phase === 'completed' ? 200 : null, cursor: 4, fingerprint: `turn:1:${phase}`, explanation: null, attention: 'none' }
  return { sessionId: id, membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'Result', titleOverride: null, workspace: '/fixture', projectId: null, tagIds: [], progress: '', status: phase === 'completed' ? 'pending_review' : 'in_progress', placement: { kind: 'builtin', status: phase === 'completed' ? 'pending_review' : 'in_progress' }, origin: { kind: 'unspecified', episodeId: runtime.episodeId, episodeOrder: runtime.episodeOrder, reason: 'before_membership' }, workflowRevision: 0, placementWitness: null, runtime, decision: null, joinedAt: 100, activityAt: 200, updatedAt: 200, reviewAt: phase === 'completed' ? 200 : null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
}
const replay = (cursor = 0, completions = []) => ({ sessionId: 'card', sourceIdentity: digestCommand('fixed-source'), throughCursor: cursor, prefixDigests: Array.from({ length: cursor + 1 }, (_, index) => digestCommand({ prefix: index })), completions, coverage: 'complete', reason: null })
function pathFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-dashboard-extension-'))
  t.after(() => {
    const canonical = realpathSync(root), parent = realpathSync(tmpdir())
    assert.equal(dirname(canonical), parent); assert(canonical.startsWith(join(parent, 'session-dashboard-extension-')))
    rmSync(canonical, { recursive: true, force: false })
  })
  return join(root, 'dashboard.sqlite')
}
test('an older schema is refused with an actionable upgrade message and left untouched', t => {
  const path = pathFor(t), db = new DatabaseSync(path)
  db.exec('CREATE TABLE board (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL); PRAGMA user_version=7;')
  db.prepare('INSERT INTO board VALUES (1, 0, ?, ?)').run('{}', digestCommand('{}'))
  db.close()
  const before = new DatabaseSync(path), raw = before.prepare('SELECT * FROM board').get(); before.close()
  assert.throws(() => new SqliteBoardStore(path, 'profile-one'), error => error.code === 'STORAGE' && /0\.6\.7/.test(error.message))
  const after = new DatabaseSync(path); t.after(() => after.close())
  assert.deepEqual(after.prepare('SELECT * FROM board').get(), raw)
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 7)
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='dashboard_meta'").get(), undefined)
})

test('future database versions and cross-profile reuse are rejected without rotating the valid store scope', t => {
  const path = pathFor(t), first = new SqliteBoardStore(path, 'profile-one'), identity = first.identity(); first.close()
  assert.throws(() => new SqliteBoardStore(path, 'profile-two'), error => error.code === 'FORBIDDEN')
  const reopened = new SqliteBoardStore(path, 'profile-one'); assert.deepEqual(reopened.identity(), identity); reopened.close()
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close()
  assert.throws(() => new SqliteBoardStore(path, 'profile-one'), /不支持/)
  const inspect = new DatabaseSync(path); t.after(() => inspect.close())
  assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 99)
})

test('final authority rejection rolls back source watermark, events, board and receipt atomically', t => {
  const store = new SqliteBoardStore(':memory:'); t.after(() => store.close())
  store.commit(null, board => { board.cards.push(card('card', 'running')); return true }, undefined, [replay()])
  const before = store.snapshot(), events = store.events(0, 200), receipt = { requestId: randomUUID(), digest: 'final-reject' }
  const completion = { episodeId: 'turn:1', cursor: 4, endedAt: 200, digest: digestCommand('completion') }
  let fences = 0, notifications = 0
  store.subscribe(() => { notifications += 1 })
  assert.throws(() => store.commit(receipt, board => { board.cards[0].progress = 'Must rollback'; board.cards[0].metadataRevision += 1; return true }, () => {
    if (++fences === 2) throw new DashboardError('FORBIDDEN', 'authorization revoked at final commit fence')
  }, [replay(4, [completion])]), error => error.code === 'FORBIDDEN')
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(store.events(0, 200), events); assert.equal(store.wasCommitted(receipt), false); assert.equal(notifications, 0)
  const result = store.commit(receipt, board => { board.cards[0].progress = 'Committed retry'; board.cards[0].metadataRevision += 1; return true }, undefined, [replay(4, [completion])])
  assert.equal(result.duplicate, false); assert.equal(store.snapshot().cards[0].sourceCursor, 4)
  assert.equal(store.events(0, 200).events.filter(event => event.kind === 'completed').length, 1)
  assert.equal(store.wasCommitted(receipt), true)
  const watermark = store.snapshot().highWatermark
  store.commit(receipt, () => { throw new Error('duplicate command must not run again') })
  assert.equal(store.snapshot().highWatermark, watermark)
})

test('postcommit listener failures cannot undo durable facts or suppress the next consumer', t => {
  const store = new SqliteBoardStore(':memory:'); t.after(() => store.close())
  const observed = []
  store.subscribe(() => { observed.push(store.snapshot().highWatermark); throw new Error('extension failed') })
  store.subscribe(() => { observed.push(store.snapshot().highWatermark) })
  const receipt = { requestId: randomUUID(), digest: 'joined' }
  store.commit(receipt, board => { board.cards.push(card()); return true }, undefined, [replay()])
  assert.deepEqual(observed, [2, 2], 'both observers see the already committed joined+baseline state')
  assert.equal(store.wasCommitted(receipt), true); assert.equal(store.read().cards.length, 1)
})

test('event retention reports explicit expired and future cursor gaps with a consistent new snapshot watermark', t => {
  let now = 1000
  const store = new SqliteBoardStore(':memory:', 'retention', () => now); t.after(() => store.close())
  store.commit(null, board => { board.cards.push(card()); return true })
  const first = store.events(0, 200).events[0]
  now += EVENT_RETENTION_MS + 1
  store.commit(null, board => { board.cards[0].progress = 'later'; board.cards[0].metadataRevision += 1; return true })
  const snapshot = store.snapshot()
  assert(snapshot.retainedFrom > first.sequence)
  assert.equal(store.events(0, 200).gap, true); assert.deepEqual(store.events(0, 200).events, [])
  const page = store.events(snapshot.retainedFrom - 1, 200)
  assert.equal(page.gap, false); assert.equal(page.highWatermark, snapshot.highWatermark); assert.equal(page.events.length, 1)
  assert.equal(store.events(snapshot.highWatermark + 1, 200).gap, true)
})

test('source prefix replacement remains an explicit gap and never duplicates already recorded completed evidence', t => {
  const store = new SqliteBoardStore(':memory:'); t.after(() => store.close())
  store.commit(null, board => { board.cards.push(card()); return true }, undefined, [replay()])
  const completion = { episodeId: 'turn:1', cursor: 4, endedAt: 200, digest: digestCommand('evidence') }
  store.commit(null, () => false, undefined, [replay(4, [completion])])
  const before = store.snapshot(), changed = replay(4, [completion]); changed.prefixDigests[4] = digestCommand('replaced-prefix')
  store.commit(null, () => false, undefined, [changed])
  assert.equal(store.snapshot().cards[0].completionCoverage, 'unavailable'); assert.equal(store.snapshot().cards[0].sourceCursor, before.cards[0].sourceCursor)
  store.commit(null, () => false, undefined, [replay(4, [completion])])
  const events = store.events(0, 200).events
  assert.equal(events.filter(event => event.kind === 'completed').length, 1)
  assert.equal(events.filter(event => event.kind === 'source_gap').length, 1)
})

async function publicHarness(t) {
  const ctx = new Context(), store = new SqliteBoardStore(':memory:'), dashboard = new DashboardService(store, absentHost()), fibers = []
  let extensions
  const owner = ctx.plugin(scope => { extensions = new DashboardExtensions(scope, store, dashboard) }); fibers.push(owner); await owner.await()
  t.after(async () => { for (const fiber of fibers.toReversed()) await fiber.dispose(); await dashboard.close() })
  const connect = async () => {
    let lease
    const consumer = ctx.plugin(scope => { lease = scope.get('sessionDashboardExtensions').connect({ apiVersion: 2 }) })
    fibers.push(consumer); await consumer.await()
    return { consumer, lease }
  }
  return { ctx, owner, store, dashboard, extensions, fibers, connect }
}

test('tampered persisted source and event payload hashes fail closed without repairing or clearing the original records', t => {
  const path = pathFor(t), store = new SqliteBoardStore(path, 'tamper-profile')
  store.commit(null, board => { board.cards.push(card()); return true }, undefined, [replay()])
  const member = store.read().cards[0].membershipId; store.close()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE memberships SET source=? WHERE id=?').run('{"tampered":"source"}', member)
  const original = db.prepare('SELECT source, source_digest FROM memberships WHERE id=?').get(member)
  db.close()
  const reopened = new SqliteBoardStore(path, 'tamper-profile'); t.after(() => reopened.close())
  assert.throws(() => reopened.snapshot(), error => error.code === 'STORAGE' && /游标校验/.test(error.message))
  const inspector = new DatabaseSync(path)
  assert.deepEqual(inspector.prepare('SELECT source, source_digest FROM memberships WHERE id=?').get(member), original)
  inspector.prepare('UPDATE domain_events SET payload=? WHERE seq=1').run('{"tampered":"event"}')
  assert.throws(() => reopened.events(0, 100), error => error.code === 'STORAGE' && /事件完整性/.test(error.message))
  assert.equal(inspector.prepare('SELECT payload FROM domain_events WHERE seq=1').get().payload, '{"tampered":"event"}')
  inspector.close()
})

test('actual Cordis service tracker binds independent read leases to real registering plugin lifetimes', async t => {
  const h = await publicHarness(t), a = await h.connect(), b = await h.connect()
  assert.equal(handshakeSchema.parse(a.lease.handshake()).apiVersion, 2)
  assert.equal(publicSnapshotSchema.parse(await a.lease.snapshot()).cards.length, 0)
  assert.equal(eventPageSchema.parse(await b.lease.events(0)).gap, false)
  const aId = a.lease.handshake().serviceId
  assert.equal(aId, b.lease.handshake().serviceId)
  assert.throws(() => h.ctx.get('sessionDashboardExtensions').connect({ apiVersion: 2 }), error => error.code === 'FORBIDDEN', 'untagged root is not a registration')
  assert.throws(() => h.owner.ctx.get('sessionDashboardExtensions').connect({ apiVersion: 2 }), error => error.code === 'FORBIDDEN', 'service owner cannot mint an extension caller')
  let aCalls = 0, bCalls = 0
  a.lease.subscribe(() => { aCalls += 1 }); b.lease.subscribe(() => { bCalls += 1 })
  await a.consumer.dispose()
  assert.throws(() => a.lease.handshake(), error => ['FORBIDDEN', 'UNAVAILABLE'].includes(error.code))
  assert.equal(b.lease.handshake().serviceId, aId)
  h.store.commit(null, board => { board.cards.push(card()); return true })
  assert.equal(aCalls, 0); assert.equal(bCalls, 1)
  b.lease.close(); assert.throws(() => b.lease.handshake(), error => error.code === 'FORBIDDEN')
})

test('actual public lease service unload/reload invalidates old epoch and browser stale query is rejected', async t => {
  const h = await publicHarness(t), first = await h.connect(), old = first.lease.handshake()
  await h.owner.dispose()
  assert.throws(() => first.lease.handshake(), error => ['FORBIDDEN', 'UNAVAILABLE'].includes(error.code))
  let replacement
  const nextDashboard = new DashboardService(h.store, absentHost())
  t.after(() => nextDashboard.close())
  const owner = h.ctx.plugin(scope => { replacement = new DashboardExtensions(scope, h.store, nextDashboard) }); h.fibers.push(owner); await owner.await()
  const next = await h.connect(), current = next.lease.handshake()
  assert.notEqual(current.serviceId, old.serviceId); assert.deepEqual(current.scope, old.scope)
  await assert.rejects(replacement.snapshot({ apiVersion: 2, serviceId: old.serviceId }, () => {}), error => error.code === 'UNAVAILABLE')
  const value = await next.lease.snapshot(); assert.equal(value.handshake.serviceId, current.serviceId)
  assert.equal(value.handshake.capabilities.isolatedExecution.available, false); assert.equal(value.handshake.capabilities.externalDelivery.available, false)
})

test('consumer disposal during an awaited snapshot rejects that pending read and releases its advisory listener', async t => {
  const h = await publicHarness(t), consumer = await h.connect()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const snapshot = h.dashboard.extensionSnapshot.bind(h.dashboard)
  h.dashboard.extensionSnapshot = async fence => { entered.resolve(); await release.promise; return snapshot(fence) }
  const pending = consumer.lease.snapshot()
  await entered.promise; await consumer.consumer.dispose(); release.resolve()
  await assert.rejects(pending, error => ['FORBIDDEN', 'UNAVAILABLE'].includes(error.code))
  const other = await h.connect(); h.dashboard.extensionSnapshot = snapshot
  assert.equal((await other.lease.snapshot()).cards.length, 0)
})

test('read-lease close is idempotent, listener failures stay local, and explicit unsubscribe really releases it', async t => {
  const h = await publicHarness(t), a = await h.connect(), b = await h.connect()
  let first = 0, second = 0
  const stopA = a.lease.subscribe(() => { first += 1; throw new Error('consumer callback failure') })
  const stopB = b.lease.subscribe(() => { second += 1 })
  h.store.commit(null, board => { board.cards.push(card()); return true })
  assert.equal(first, 1); assert.equal(second, 1)
  stopA(); stopA(); h.store.commit(null, board => { board.cards[0].progress = 'update'; board.cards[0].metadataRevision += 1; return true })
  assert.equal(first, 1); assert.equal(second, 2)
  stopB(); a.lease.close(); a.lease.close(); b.lease.close()
  assert.throws(() => a.lease.subscribe(() => {}), error => error.code === 'FORBIDDEN')
})

test('real Gateway extension queries keep exact browser identity and reject stale service epochs and disconnected readers', async t => {
  const h = await publicHarness(t), { peer, replacePeer } = browserPeer(h.ctx, 'extension-browser')
  for (const [plugin, config] of [[Registry, undefined], [SessionDashboardRemote, h.dashboard]]) {
    // Remote constructor has a third assembled dependency, so mount it explicitly
    // as an actual plugin rather than forging this.ctx.invocation.
    const fiber = plugin === SessionDashboardRemote ? h.ctx.plugin(scope => { new SessionDashboardRemote(scope, h.dashboard, h.extensions) }) : h.ctx.plugin(plugin, config)
    h.fibers.push(fiber); await fiber.await()
  }
  h.ctx.typert.register(TYPERT)
  const access = await mountGatewayPrerequisites(h.ctx); if (access) h.fibers.push(access)
  const gateway = h.ctx.plugin(Gateway, {}); h.fibers.push(gateway); await gateway.await()
  const invoke = (method, args = {}, extra = {}) => h.ctx.typertGateway.invoke({ namespace: 'sessionDashboard', method, args, peer, ...extra })
  const handshake = handshakeSchema.parse(await invoke('handshake'))
  const result = publicSnapshotSchema.parse(await invoke('extensionSnapshot', { query: { apiVersion: 2, serviceId: handshake.serviceId } }))
  assert.equal(result.cards.length, 0)
  await assert.rejects(invoke('extensionSnapshot', { query: { apiVersion: 2, serviceId: randomUUID() } }), error => error.code === 'dashboard/error' && error.details.reason === 'UNAVAILABLE')
  await assert.rejects(invoke('extensionEvents', { query: { apiVersion: 2, serviceId: handshake.serviceId, after: 0, limit: 100 } }, { peer: { ...peer } }), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
  replacePeer({ ...peer })
  await assert.rejects(invoke('handshake'), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
})

test('public snapshot card summaries expose the system turn-end reason, null when unknown', async t => {
  const h = await publicHarness(t)
  const plain = card('plain'), ended = card('ended')
  ended.runtime = { ...ended.runtime, turnEnd: { kind: 'error', error: { code: 'rate_limit', status: 429 } } }
  const forked = card('forked')
  forked.runtime = { ...forked.runtime, turnEnd: { kind: 'forked' } }
  h.store.commit(null, board => { board.cards.push(plain, ended, forked); return true })
  const { lease } = await h.connect()
  const snapshot = publicSnapshotSchema.parse(await lease.snapshot())
  const byId = Object.fromEntries(snapshot.cards.map(row => [row.sessionId, row]))
  assert.equal(byId.plain.turnEnd, null, 'a run without a known system end reason is explicitly null')
  assert.deepEqual(byId.ended.turnEnd, { kind: 'error', error: { code: 'rate_limit', status: 429 } })
  assert.deepEqual(byId.forked.turnEnd, { kind: 'forked' }, 'the union variants survive the public schema unchanged')
})
