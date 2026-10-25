import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { boardSchema, effectiveTagIds, emptyBoard, placementSchema, projectTagIds, unknownRuntime } from '../lib/shared/model.js'
import { DASHBOARD_API_VERSION, cardSummarySchema, domainEventSchema, handshakeSchema, publicQuerySchema } from '../lib/shared/extension.js'
import { parseStoredDomainEvent } from '../lib/backend/store.js'
import { commandSchema, mutationSchema, sessionInspectionBindingSchema, sessionInspectionSchema } from '../lib/shared/commands.js'
import { HISTORY_MEMBER_CAPACITY, HISTORY_PAGE_LIMIT, HISTORY_STORE_CAPACITY, historyPageSchema, historyQuerySchema, historyRecordSchema } from '../lib/shared/history.js'
import { descriptors } from '../lib/shared/contract.js'
import { Context } from '@deepseek-ai/cordis'
import { DashboardExtensions } from '../lib/backend/extensions.js'
import { DashboardService } from '../lib/backend/service.js'
import { SqliteBoardStore } from '../lib/backend/store.js'

function inspectionBinding() {
  return { serviceId: randomUUID(), boardRevision: 0, membershipId: null, metadataRevision: null, lifecycleRevision: null, workflowRevision: null, runtimeFingerprint: 'verified-cut', sourceIdentity: 'source', sourceCursor: 4, hostArchiveGeneration: 'archive-cut' }
}
function workflowBinding() { return { sessionId: 'session', membershipId: randomUUID(), expectedMetadataRevision: 4, expectedLifecycleRevision: 6, expectedWorkflowRevision: 8, episodeId: 'turn:5' } }
function scope() { return { scopeId: randomUUID(), storeId: randomUUID(), recoveryId: randomUUID() } }
function handshake() {
  const yes = { available: true, reason: null }
  return { apiVersion: 2, serviceId: randomUUID(), scope: scope(), capabilities: { query: yes, events: yes, completionReplay: yes, evidenceCheck: yes, nativeSidebarFilter: yes, isolatedExecution: yes, externalDelivery: yes, projectWorkflow: yes, businessHistory: yes, sessionInspection: yes, sidebarEntry: yes } }
}

test('the current board schema is strict and only accepts its own version', () => {
  assert.equal(boardSchema.parse(emptyBoard()).schemaVersion, 11)
  assert.equal(emptyBoard().preferences.entry, 'projects')
  assert.deepEqual(Object.keys(emptyBoard().preferences).sort(), ['collapsedProjects', 'entry', 'locations', 'revision'])
  assert.deepEqual(Object.keys(emptyBoard().preferences.locations), ['projects'])
  const legacy = { ...emptyBoard(), edges: [] }
  assert.equal(boardSchema.safeParse(legacy).success, false, 'removed relation edges are rejected by the strict board')
  const removedView = structuredClone(emptyBoard()); removedView.preferences.groupBy = 'status'
  assert.equal(boardSchema.safeParse(removedView).success, false, 'removed preference branches are rejected by the strict schema')
  assert.equal(boardSchema.safeParse({ ...emptyBoard(), schemaVersion: 2 }).success, false, 'an old version label is not accepted as current data')
  const smuggled = structuredClone(emptyBoard()); smuggled.projects.push({ id: 'p', name: 'P', color: null, createdAt: 1, revision: 0, tagIds: [], states: [] })
  assert.equal(boardSchema.safeParse(smuggled).success, false, 'retired per-project states cannot be smuggled into current data')
})

test('workflow and membership CAS plus service epoch are mandatory; project edit and historical shortcuts are absent', () => {
  const binding = workflowBinding()
  const target = { statusId: 's', expectedStatusRevision: 2 }
  const review = { type: 'review', ...binding, action: 'accept', confirmed: true, destination: { kind: 'custom', target } }
  assert.deepEqual(commandSchema.parse(review), review)
  for (const field of ['membershipId', 'expectedMetadataRevision', 'expectedLifecycleRevision', 'expectedWorkflowRevision', 'destination']) {
    const stale = { ...review }; delete stale[field]
    assert.equal(commandSchema.safeParse(stale).success, false, `${field} is required`)
  }
  const mutation = { apiVersion: 2, serviceId: randomUUID(), requestId: randomUUID(), command: review }
  assert.deepEqual(mutationSchema.parse(mutation), mutation)
  const noEpoch = { ...mutation }; delete noEpoch.serviceId
  assert.equal(mutationSchema.safeParse(noEpoch).success, false)
  assert.equal(mutationSchema.safeParse({ ...mutation, apiVersion: 1 }).success, false)
  const edit = { type: 'edit_card', sessionId: binding.sessionId, membershipId: binding.membershipId, expectedMetadataRevision: 4, tagIds: [], titleOverride: null, progress: '' }
  assert.deepEqual(commandSchema.parse(edit), edit)
  assert.equal(commandSchema.safeParse({ ...edit, projectId: 'p' }).success, false)
  const add = { type: 'add_card', sessionId: 's', projectId: 'p', inspection: inspectionBinding() }
  assert.deepEqual(commandSchema.parse(add), add)
  assert.equal(commandSchema.safeParse({ ...add, confirmHistorical: true }).success, false)
  assert.equal(commandSchema.safeParse({ type: 'create_label', dimension: 'project', name: 'P', color: null }).success, false)
})

test('inspection captures exactly one candidate plus snapshot and absent-membership proof', () => {
  const binding = inspectionBinding()
  assert.deepEqual(sessionInspectionBindingSchema.parse(binding), binding)
  const value = { snapshot: { board: emptyBoard(), health: { state: 'ready', message: null, lastSyncAt: null } }, candidate: { sessionId: 's', title: 'S', workspace: null, activityAt: null, tracked: null, runtime: unknownRuntime(), hostArchive: { state: 'active', reason: null } }, binding }
  assert.deepEqual(sessionInspectionSchema.parse(value), value)
  const noEpoch = { ...binding }; delete noEpoch.serviceId
  assert.equal(sessionInspectionBindingSchema.safeParse(noEpoch).success, false)
  assert.deepEqual(descriptors.find(row => row.method === 'inspectSession').parameters[0].codec.create().parse({ sessionId: 's' }), { sessionId: 's' })
})

test('project and own tag derivations preserve both sources without copying or widening own tags', () => {
  const board = emptyBoard(), own = ['shared', 'own']
  board.projects.push({ id: 'p', name: 'P', color: null, createdAt: 0, revision: 0, tagIds: ['shared', 'project'] })
  const card = { projectId: 'p', tagIds: own }
  assert.deepEqual(projectTagIds(board, card), ['shared', 'project'])
  assert.deepEqual(effectiveTagIds(board, card), ['shared', 'own', 'project'])
  assert.deepEqual(own, ['shared', 'own'])
  board.projects[0].tagIds = []
  assert.deepEqual(effectiveTagIds(board, card), ['shared', 'own'])
  assert.deepEqual(placementSchema.parse({ kind: 'custom', statusId: 'complete' }), { kind: 'custom', statusId: 'complete' })
  assert.equal(placementSchema.safeParse({ kind: 'builtin', status: 'complete' }).success, false)
})

test('API2 is explicit and old event payloads are not accepted as current events', () => {
  assert.equal(DASHBOARD_API_VERSION, 2)
  assert.deepEqual(handshakeSchema.parse(handshake()).apiVersion, 2)
  assert.equal(publicQuerySchema.safeParse({ apiVersion: 1 }).success, false)
  const event = { schemaVersion: 1, eventId: randomUUID(), sequence: 1, scope: scope(), sessionId: 's', membershipId: randomUUID(), kind: 'removed', episodeId: null, sourceIdentity: null, sourceCursor: null, occurredAt: 1, observedAt: 1, committedAt: 1, boardRevision: 1, historical: false, summary: null, evidenceDigest: null, reason: null }
  assert.equal(domainEventSchema.safeParse(event).success, false)
  assert.deepEqual(domainEventSchema.parse({ ...event, schemaVersion: 2 }).schemaVersion, 2)
})

test('card summaries persisted before turnEnd existed still parse', () => {
  const summary = {
    sessionId: 's', membershipId: randomUUID(), title: 'S', projectId: null, tagIds: [], projectTagIds: [], effectiveTagIds: [],
    status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, workflowRevision: 0,
    episodeId: null, lifecycleRevision: 0, metadataRevision: 0, cancellationGeneration: 0,
    completionCoverage: 'unavailable', sourceIdentity: null, sourceCursor: null, completionEvidenceDigest: null,
    archived: false, hostArchive: { state: 'active', reason: null }, attention: 'none', sync: 'synced', sourceLive: true,
    phase: 'completed', endedAt: 1, reviewAt: null,
  }
  assert.equal('turnEnd' in cardSummarySchema.parse(summary), false, 'an old event without the field stays readable')
  assert.equal(cardSummarySchema.parse({ ...summary, turnEnd: null }).turnEnd, null)
  assert.deepEqual(cardSummarySchema.parse({ ...summary, turnEnd: { kind: 'completed' } }).turnEnd, { kind: 'completed' })
})

test('stored events written before schema 8 keep decoding', () => {
  const event = { schemaVersion: 2, eventId: randomUUID(), sequence: 1, scope: scope(), sessionId: 's', membershipId: randomUUID(), kind: 'metadata', episodeId: null, sourceIdentity: null, sourceCursor: null, occurredAt: 1, observedAt: 1, committedAt: 1, boardRevision: 1, historical: false, summary: { sessionId: 's', membershipId: randomUUID(), title: 'S', projectId: null, priorityId: 'retired', tagIds: [], projectTagIds: [], effectiveTagIds: [], status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, workflowRevision: 0, episodeId: null, lifecycleRevision: 0, metadataRevision: 0, cancellationGeneration: 0, completionCoverage: 'unavailable', sourceIdentity: null, sourceCursor: null, completionEvidenceDigest: null, archived: false, hostArchive: { state: 'active', reason: null }, attention: 'none', sync: 'synced', sourceLive: true, phase: 'completed', endedAt: 1, reviewAt: null }, evidenceDigest: null, reason: null }
  const parsed = parseStoredDomainEvent(JSON.stringify(event))
  assert.equal('priorityId' in parsed.summary, false, 'the retired priority pointer is dropped from the decoded view')
  assert.equal(parsed.summary.turnEnd, undefined, 'a summary without turnEnd still decodes')
})

test('event queries preserve strict public-query boundaries through actual Cordis readonly leases', async t => {
  const root = new Context(), fibers = [], identity = scope(), serviceId = randomUUID(), reads = []
  const store = {
    identity: () => identity,
    events: (after, limit) => { reads.push({ after, limit }); return { scope: identity, highWatermark: 0, retainedFrom: 1, nextCursor: after, events: [], gap: false } },
  }
  let extensions, lease
  t.after(async () => { for (const fiber of fibers.toReversed()) await fiber.dispose() })
  const owner = root.plugin(ctx => { extensions = new DashboardExtensions(ctx, store, { serviceId }) })
  fibers.push(owner); await owner.await()
  const consumer = root.plugin(ctx => { lease = ctx.get('sessionDashboardExtensions').connect({ apiVersion: 2 }) })
  fibers.push(consumer); await consumer.await()
  let fences = 0
  const query = { apiVersion: 2, serviceId, after: 0, limit: 10 }
  assert.equal(publicQuerySchema.safeParse(query).success, false, 'after/limit must remain forbidden to the strict public-query schema')
  assert.equal(extensions.events(query, () => { fences++ }).gap, false)
  assert.equal(fences, 2, 'event authority remains checked before and after the store read')
  assert.equal(extensions.events({ apiVersion: 2, after: 0, limit: 1 }, () => {}).handshake.serviceId, serviceId)
  assert.equal((await lease.events(0)).gap, false)
  assert.equal((await lease.events(0, 7)).handshake.serviceId, serviceId)
  assert.deepEqual(reads, [{ after: 0, limit: 10 }, { after: 0, limit: 1 }, { after: 0, limit: 100 }, { after: 0, limit: 7 }])
  assert.throws(() => extensions.events({ ...query, serviceId: randomUUID() }, () => {}), error => error.code === 'UNAVAILABLE')
  assert.throws(() => extensions.events({ ...query, unexpected: true }, () => {}))
  assert.throws(() => extensions.events({ ...query, apiVersion: 1 }, () => {}), error => error.code === 'UNSUPPORTED_API')
  assert.equal(reads.length, 4, 'rejected event requests never reach storage')
  lease.close()
  await assert.rejects(lease.events(0), error => error.code === 'FORBIDDEN')
})

test('readonly snapshots withdraw ephemeral sync failures when both durable writes fail and recover per member', async t => {
  const root = new Context(), fibers = [], store = new SqliteBoardStore(':memory:'), observations = new Map(), sources = new Map(), listeners = new Set(), reported = []
  const makeCard = sessionId => ({ sessionId, membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: sessionId, titleOverride: null, workspace: null, projectId: null, tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, origin: { kind: 'unspecified', episodeId: 'turn:1', episodeOrder: 1, reason: 'no_state' }, placementWitness: null, workflowRevision: 0, runtime: { sync: 'synced', phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, startedAt: 10, endedAt: 20, cursor: 3, sourceLive: true, fingerprint: 'complete', explanation: null, attention: 'none', activeAgents: 0 }, decision: null, joinedAt: 0, activityAt: 20, updatedAt: 20, reviewAt: 20, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 })
  const cards = [makeCard('failing-session'), makeCard('healthy-session')]
  for (const card of cards) {
    observations.set(card.sessionId, { runtime: structuredClone(card.runtime), title: card.hostTitle, workspace: null, activityAt: 20, hostArchive: card.hostArchive })
    sources.set(card.sessionId, { sessionId: card.sessionId, sourceIdentity: `source:${card.sessionId}`, throughCursor: 3, prefixDigests: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)], completions: [{ episodeId: 'turn:1', cursor: 3, endedAt: 20, digest: 'e'.repeat(64) }], coverage: 'complete', reason: null })
  }
  store.commit(null, board => { board.cards.push(...cards); return true }, undefined, [...sources.values()])
  const host = {
    capture: async sessionId => ({ observation: structuredClone(observations.get(sessionId)), source: structuredClone(sources.get(sessionId)), validate: () => true, dispose() {} }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, transcript: async () => ({ messages: [], truncated: false }), close() { listeners.clear() },
  }
  const dashboard = new DashboardService(store, host, error => { reported.push(error) })
  t.after(async () => { for (const fiber of fibers.toReversed()) await fiber.dispose(); await dashboard.close() })
  const owner = root.plugin(ctx => { new DashboardExtensions(ctx, store, dashboard) }); fibers.push(owner); await owner.await()
  let lease
  const consumer = root.plugin(ctx => { lease = ctx.get('sessionDashboardExtensions').connect({ apiVersion: 2 }) }); fibers.push(consumer); await consumer.await()
  const initial = await lease.snapshot()
  assert(initial.cards.every(card => card.sync === 'synced' && card.sourceLive && card.completionCoverage === 'complete' && card.completionEvidenceDigest === 'e'.repeat(64)))
  const failing = observations.get('failing-session')
  failing.runtime = { ...failing.runtime, sync: 'unknown', sourceLive: false, explanation: 'Injected temporary host outage', attention: 'sync', fingerprint: 'unavailable' }
  const commit = store.commit.bind(store)
  let failures = 0
  store.commit = (...args) => { failures++; throw new Error('Injected durable commit failure') }
  for (const listener of listeners) listener('failing-session')
  const unavailable = await lease.snapshot(), staleDisk = store.snapshot()
  const bad = unavailable.cards.find(card => card.sessionId === 'failing-session'), stale = staleDisk.cards.find(card => card.sessionId === 'failing-session')
  assert(failures >= 2, 'both runtime refresh and its error-persistence write actually failed')
  assert(reported.length > 0)
  assert.equal(stale.sync, 'synced'); assert.equal(stale.sourceLive, true); assert.equal(stale.completionCoverage, 'complete'); assert.equal(stale.completionEvidenceDigest, 'e'.repeat(64))
  assert.equal(bad.sync, 'unknown'); assert.equal(bad.sourceLive, false); assert.equal(bad.attention, 'sync'); assert.equal(bad.completionCoverage, 'unavailable'); assert.equal(bad.completionEvidenceDigest, null)
  assert.deepEqual(bad.origin, stale.origin); assert.equal(bad.sourceIdentity, stale.sourceIdentity); assert.equal(bad.sourceCursor, stale.sourceCursor)
  const healthy = unavailable.cards.find(card => card.sessionId === 'healthy-session')
  assert.equal(healthy.sync, 'synced'); assert.equal(healthy.sourceLive, true); assert.equal(healthy.completionCoverage, 'complete'); assert.equal(healthy.completionEvidenceDigest, 'e'.repeat(64))
  const ui = await dashboard.snapshot()
  assert.equal(ui.health.state, 'degraded'); assert.equal(ui.board.cards.find(card => card.sessionId === 'failing-session').runtime.sync, 'unknown')
  store.commit = commit
  observations.set('failing-session', { runtime: structuredClone(cards[0].runtime), title: 'failing-session', workspace: null, activityAt: 20, hostArchive: { state: 'active', reason: null } })
  const recovered = await lease.snapshot(), current = recovered.cards.find(card => card.sessionId === 'failing-session')
  assert.equal(current.sync, 'synced'); assert.equal(current.sourceLive, true); assert.equal(current.completionCoverage, 'complete'); assert.equal(current.completionEvidenceDigest, 'e'.repeat(64))
  assert.equal((await dashboard.snapshot()).health.state, 'ready')
})

test('business-history contracts bound pages and require explicit old-name snapshots and pruning information', () => {
  assert.equal(HISTORY_MEMBER_CAPACITY, 1000); assert.equal(HISTORY_STORE_CAPACITY, 100000); assert.equal(HISTORY_PAGE_LIMIT, 100)
  const member = randomUUID()
  const record = { schemaVersion: 1, id: randomUUID(), sequence: 1, sessionId: 's', membershipId: member, kind: 'legacy_decision', at: 100, episodeId: null, origin: null, fromProjectId: null, toProjectId: null, from: { kind: 'builtin', status: 'accepted' }, to: { kind: 'builtin', status: 'accepted' }, fromProject: null, toProject: null, fromState: null, toState: null, decision: { kind: 'historical', episodeId: null, at: 100 }, requestId: null }
  assert.deepEqual(historyRecordSchema.parse(record), record)
  const missingNameProof = { ...record }; delete missingNameProof.toState
  assert.equal(historyRecordSchema.safeParse(missingNameProof).success, false)
  assert.deepEqual(historyQuerySchema.parse({ sessionId: 's', membershipId: member, limit: 100 }), { sessionId: 's', membershipId: member, limit: 100 })
  assert.equal(historyQuerySchema.safeParse({ sessionId: 's', membershipId: member, limit: 101 }).success, false)
  const page = { sessionId: 's', membershipId: member, records: [record], nextAfter: null, retainedFrom: 1, highWatermark: 1, truncated: false, gap: false }
  assert.deepEqual(historyPageSchema.parse(page), page)
  assert.deepEqual(descriptors.find(row => row.method === 'history').parameters[0].codec.create().parse({ sessionId: 's', membershipId: member, after: 1, limit: 10 }), { sessionId: 's', membershipId: member, after: 1, limit: 10 })
})
