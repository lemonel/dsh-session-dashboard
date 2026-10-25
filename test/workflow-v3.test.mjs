import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SqliteBoardStore, digestCommand } from '../lib/backend/store.js'
import { DashboardService } from '../lib/backend/service.js'
import { parseBoard } from '../lib/backend/invariants.js'

export function v3Harness(t, path = ':memory:') {
  const store = new SqliteBoardStore(path), values = new Map(), listeners = new Set()
  let generation = 0
  const host = {
    async capture(id) { const value = values.get(id); if (!value) throw new Error('No fixture source'); const version = generation; return { observation: structuredClone(value.observation), source: structuredClone(value.source), validate: () => version === generation, dispose() {} } },
    async list() { return { items: [], total: 0, nextOffset: null, generation: String(generation) } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, close() {},
  }
  const service = new DashboardService(store, host)
  t.after(() => service.close())
  const set = (phase = 'not_started', order = 0, cursor = order || 2, sourceIdentity = digestCommand('workflow-source')) => {
    const episodeId = order ? `turn:${order}` : null
    const runtime = { sync: 'synced', phase, episodeId, episodeOrder: order, startedAt: order ? 100 : null, endedAt: phase === 'completed' ? 200 : null, cursor, sourceLive: true, fingerprint: `${episodeId}:${phase}`, explanation: null, attention: 'none', activeAgents: 0 }
    values.set('a', { observation: { runtime, title: 'Actual fixture source', workspace: '/a', activityAt: 200, hostArchive: { state: 'active', reason: null } }, source: { sessionId: 'a', sourceIdentity, throughCursor: cursor, prefixDigests: Array.from({ length: cursor + 1 }, (_, index) => digestCommand({ sourceIdentity, index })), completions: phase === 'completed' ? [{ episodeId, cursor, endedAt: 200, digest: digestCommand({ episodeId, cursor }) }] : [], coverage: 'complete', reason: null } })
    generation += 1
  }
  set()
  const mutate = (command, requestId = randomUUID(), serviceId = service.serviceId) => service.mutate({ apiVersion: 2, serviceId, requestId, command })
  const card = () => store.read().cards[0]
  const binding = () => { const c = card(); return { sessionId: 'a', membershipId: c.membershipId, expectedMetadataRevision: c.metadataRevision, expectedLifecycleRevision: c.lifecycleRevision, expectedWorkflowRevision: c.workflowRevision, episodeId: c.runtime.episodeId } }
  const project = async name => { await mutate({ type: 'create_project', name, color: null, tagIds: [] }); return store.read().projects.find(p => p.name === name) }
  const status = async name => { await mutate({ type: 'create_label', dimension: 'status', name, color: null }); return store.read().statuses.find(s => s.name === name) }
  const target = state => ({ statusId: state.id, expectedStatusRevision: state.revision })
  const add = async projectId => { const inspected = await service.inspectSession({ sessionId: 'a' }); return mutate({ type: 'add_card', sessionId: 'a', projectId, inspection: inspected.binding }) }
  const choose = (state, extra = {}) => mutate({ type: 'choose_state', ...binding(), selection: { kind: 'custom', target: target(state) }, ...extra })
  const sync = () => mutate({ type: 'resync', sessionId: 'a' })
  const review = async (action = 'accept', destination = { kind: 'stay' }, requestId) => {
    const row = card()
    if (row.status === 'pending_confirm' && row.runtime.sync === 'synced' && row.runtime.sourceLive && row.runtime.phase === 'completed') await mutate({ type: 'confirm_review', ...binding() })
    return mutate({ type: 'review', ...binding(), action, destination, confirmed: true }, requestId)
  }
  return { store, service, values, set, mutate, card, binding, project, status, target, add, choose, sync, review }
}
const code = expected => error => error.code === expected

test('v3 reliable witnessed custom source, atomic accept destination, late completion and exact retry', async t => {
  const h = v3Harness(t), p = await h.project('Project'), a = await h.status('Research'), b = await h.status('Delivery')
  await h.add(p.id); assert.equal(h.card().placement.kind, 'unset')
  await h.choose(a)
  const witnessed = h.card(); assert.equal(witnessed.placementWitness.cursor, 2)
  h.set('running', 3, 4); await h.sync()
  assert.equal(h.card().origin.kind, 'state'); assert.equal(h.card().origin.state.statusName, 'Research')
  h.set('completed', 3, 7); await h.sync()
  const requestId = randomUUID()
  await h.mutate({ type: 'confirm_review', ...h.binding() })
  const command = { type: 'review', ...h.binding(), action: 'accept', confirmed: true, destination: { kind: 'custom', target: h.target(b) } }
  await h.mutate(command, requestId)
  assert.equal(h.card().placement.statusId, b.id); assert.equal(h.card().decision.kind, 'accepted')
  const history = h.store.history({ sessionId: 'a', membershipId: h.card().membershipId, limit: 100 })
  assert.equal(history.records.filter(r => r.kind === 'accepted').length, 1)
  assert.equal(history.records.find(r => r.kind === 'accepted').toState.statusName, 'Delivery')
  h.set('completed', 3, 8); await h.sync(); await h.mutate(command, requestId)
  assert.equal(h.card().placement.statusId, b.id)
  assert.equal(h.store.history({ sessionId: 'a', membershipId: h.card().membershipId, limit: 100 }).records.filter(r => r.kind === 'accepted').length, 1)
  h.set('running', 9, 10); await h.sync(); assert.equal(h.card().origin.state.statusId, b.id)
})

test('v3 delayed start cannot bind latest selection; rename and member source gap never backfill', async t => {
  const h = v3Harness(t), p = await h.project('Project'), a = await h.status('Old arrangement')
  await h.add(p.id); await h.choose(a)
  h.set('completed', 1, 5); await h.sync()
  assert.equal(h.card().origin.kind, 'unspecified'); assert.equal(h.card().placement.kind, 'builtin')
  await h.review()
  await h.choose(a)
  const current = h.store.read().statuses[0]
  await h.mutate({ type: 'update_label', dimension: 'status', id: current.id, expectedRevision: current.revision, name: 'Renamed', color: null })
  h.set('running', 6, 7); await h.sync(); assert.equal(h.card().origin.kind, 'unspecified')
  h.set('completed', 6, 8); await h.sync(); await h.review()
  h.set('completed', 6, 9, digestCommand('replaced-source')); await h.sync()
  assert.equal(h.store.snapshot().cards[0].completionCoverage, 'unavailable')
  await assert.rejects(h.choose(a), code('UNAVAILABLE'))
  assert.equal(h.card().placementWitness, null)
})

test('v3 cross-project moves preserve the witnessed snapshot; stale workflow/service CAS fail closed', async t => {
  const h = v3Harness(t), p = await h.project('One'), a = await h.status('Same'), q = await h.project('Two')
  await h.add(p.id); await h.choose(a); h.set('running', 3, 4); await h.sync()
  const stale = h.binding(), targetProject = h.store.read().projects.find(p => p.id === q.id)
  await h.mutate({ type: 'move_project', ...stale, projectId: q.id, destination: { kind: 'preserve' }, expectedTargetProjectRevision: targetProject.revision })
  assert.equal(h.card().projectId, q.id)
  assert.equal(h.card().origin.state.statusName, 'Same')
  await assert.rejects(h.mutate({ type: 'review', ...stale, action: 'accept', destination: { kind: 'stay' }, confirmed: true }), code('CONFLICT'))
  h.set('running', 5, 6); await h.sync(); assert.equal(h.card().origin.kind, 'unspecified')
  // The status is board-wide now, so the only reason to refuse is an unresolved round.
  await assert.rejects(h.choose(a), code('INVALID'))
  await assert.rejects(h.mutate({ type: 'resync', sessionId: null }, randomUUID(), randomUUID()), code('UNAVAILABLE'))
  const invalid = h.store.read(); invalid.cards[0].placement = { kind: 'unset' }; assert.throws(() => parseBoard(invalid), /未解决/)
})

test('v3 same-identity modified prefix cannot bind a later origin or rearm through selection', async t => {
  const h = v3Harness(t), p = await h.project('Prefix safety'), a = await h.status('Arranged')
  await h.add(p.id); await h.choose(a)
  h.set('running', 3, 4)
  h.values.get('a').source.prefixDigests[2] = digestCommand('rewritten checked prefix')
  await h.sync()
  assert.equal(h.card().origin.kind, 'unspecified'); assert.equal(h.card().placementWitness, null)
  assert.equal(h.store.snapshot().cards[0].completionCoverage, 'unavailable')
  h.set('completed', 3, 6); await h.sync()
  await assert.rejects(h.review(), code('REVIEW_STALE'))
  assert.equal(h.card().decision, null)
})

test('v3 a synced wait with no episode cannot hide behind a previous custom state', async t => {
  const h = v3Harness(t), p = await h.project('Wait safety'), a = await h.status('Arranged')
  await h.add(p.id); await h.choose(a)
  const old = h.binding()
  h.set('waiting_input', 0, 3); await h.sync()
  assert.equal(h.card().placement.kind, 'builtin'); assert.equal(h.card().runtime.episodeId, null)
  await assert.rejects(h.choose(a), code('INVALID'))
  await assert.rejects(h.choose(a, old), error => ['REVIEW_STALE', 'CONFLICT'].includes(error.code))
  const history = h.store.history({ sessionId: 'a', membershipId: h.card().membershipId, limit: 100 })
  assert.equal(history.records.filter(record => record.kind === 'episode_started').length, 0)
})

test('v3 own-tag ABA invalidates tasks even when project and effective tags are unchanged', async t => {
  const h = v3Harness(t), p = await h.project('Dual tags')
  await h.mutate({ type: 'create_label', dimension: 'tag', name: 'T', color: null })
  const tag = h.store.read().tags[0], project = h.store.read().projects[0]
  await h.mutate({ type: 'update_project', projectId: p.id, expectedProjectRevision: project.revision, name: project.name, color: null, tagIds: [tag.id] })
  await h.add(p.id)
  const edit = tagIds => { const c = h.card(); return h.mutate({ type: 'edit_card', sessionId: 'a', membershipId: c.membershipId, expectedMetadataRevision: c.metadataRevision, tagIds, titleOverride: null, progress: '' }) }
  await edit([tag.id]); const first = h.store.snapshot().cards[0]
  await edit([]); const second = h.store.snapshot().cards[0]
  await edit([tag.id]); const third = h.store.snapshot().cards[0]
  assert.deepEqual(first.effectiveTagIds, [tag.id]); assert.deepEqual(second.effectiveTagIds, first.effectiveTagIds); assert.deepEqual(third.effectiveTagIds, first.effectiveTagIds)
  assert(second.cancellationGeneration > first.cancellationGeneration); assert(third.cancellationGeneration > second.cancellationGeneration)
  assert.equal(h.store.history({ sessionId: 'a', membershipId: h.card().membershipId, limit: 100 }).records.length, 0, 'tag edits do not forge workflow/acceptance history')
})

test('v3 final fence rejects both acceptance and destination/history/receipt without partial commit', async t => {
  const h = v3Harness(t), p = await h.project('Atomic'), a = await h.status('Next')
  h.set('completed', 1, 5); await h.add(p.id)
  const before = h.card(), history = h.store.history({ sessionId: 'a', membershipId: before.membershipId, limit: 100 }), original = h.store.commit.bind(h.store)
  let armed = true
  h.store.commit = (receipt, change, fence, sources) => { let calls = 0; return original(receipt, change, () => { if (receipt && ++calls === 2 && armed) { armed = false; h.set('running', 6, 7) }; fence?.() }, sources) }
  const requestId = randomUUID(), command = { type: 'review', ...h.binding(), action: 'accept', confirmed: true, destination: { kind: 'custom', target: h.target(a) } }
  await assert.rejects(h.mutate(command, requestId), code('REVIEW_STALE'))
  assert.equal(h.card().decision, null); assert.equal(h.card().placement.kind, 'builtin')
  assert.deepEqual(h.store.history({ sessionId: 'a', membershipId: before.membershipId, limit: 100 }), history)
  assert.equal(h.store.wasCommitted({ requestId, digest: digestCommand(command) }), false)
})
