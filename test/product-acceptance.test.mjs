import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { SqliteBoardStore, digestCommand } from '../lib/backend/store.js'
import { DashboardService } from '../lib/backend/service.js'
import { mutationFor, workflowBinding } from './helpers.mjs'
import { denyNetwork, executionWorkspace, eventsOf, latch, prompt, textResponse, userMessage } from './tools/execution-host.mjs'
import { choose, custom, disposition, move, ownEdit, project, projectIn, reason, review, state, summary, tag, updateProject, updateState } from './tools/product-acceptance.mjs'

// Independent product sequences, not another implementation of state/origin/CAS.
// No fabricated events or fake agents: the installed AgentLoop owns every turn.
test('A01/A03/A05 real absence race, exact retry and own/project tag changes never execute or flow', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const h = await (await executionWorkspace(t)).start()
  const common = await tag(h, 'Both sources'), other = await tag(h, 'Target only')
  const p = await project(h, 'Empty first', [common.id]), q = await project(h, 'Target', [other.id])
  const initial = await state(h, 'Preparation')
  assert.equal((await h.snapshot()).board.cards.length, 0, 'empty projects are useful before any session exists')
  const agent = await h.create('product-tags')
  const inspected = await h.inspect(agent.id)
  assert.equal(inspected.binding.membershipId, null)
  const command = { type: 'add_card', sessionId: agent.id, projectId: p.id, inspection: inspected.binding }
  const first = h.envelope(command), competing = h.envelope(command)
  const race = await Promise.allSettled([h.submit(first), h.submit(competing)])
  assert.equal(race.filter(value => value.status === 'fulfilled').length, 1)
  assert(race.some(value => value.status === 'rejected' && reason('CONFLICT')(value.reason)))
  let card = await h.card(agent.id)
  assert.equal(card.projectId, p.id); assert.equal(card.decision, null)
  await h.mutate(choose(card, custom(await h.snapshot(), initial.id)))
  card = await h.card(agent.id)
  await h.mutate(ownEdit(card, { tagIds: [common.id], progress: 'Hand-written progress', titleOverride: 'Keep this title' }))
  const before = await h.card(agent.id), historyBefore = await h.history(before)
  let publicCard = await summary(h, agent.id)
  assert.deepEqual(publicCard.tagIds, [common.id]); assert.deepEqual(publicCard.projectTagIds, [common.id]); assert.deepEqual(publicCard.effectiveTagIds, [common.id])
  await updateProject(h, projectIn(await h.snapshot(), p.id), { tagIds: [] })
  publicCard = await summary(h, agent.id)
  assert.deepEqual(publicCard.tagIds, [common.id]); assert.deepEqual(publicCard.projectTagIds, []); assert.deepEqual(publicCard.effectiveTagIds, [common.id])
  assert.deepEqual(disposition(await h.card(agent.id)), disposition(before))
  assert.deepEqual((await h.history(before)).records, historyBefore.records, 'ordinary tags do not create business transitions')
  // An old absence token cannot overwrite an existing member, even with a new UUID.
  await assert.rejects(h.submit(h.envelope(command)), reason('CONFLICT'))
  const winner = race[0].status === 'fulfilled' ? first : competing
  await h.submit(winner)
  assert.equal((await h.card(agent.id)).progress, before.progress)
  const tracked = await h.inspect(agent.id)
  await h.mutate({ type: 'add_card', sessionId: agent.id, projectId: q.id, inspection: tracked.binding })
  assert.equal((await h.card(agent.id)).projectId, p.id, 'same-member add is not a hidden move')
  const checked = await h.card(agent.id), snapshot = await h.snapshot()
  await assert.rejects(h.mutate(move(checked, snapshot, q.id, { kind: 'preserve' })), reason('INVALID'))
  await h.mutate(move(checked, snapshot, q.id, { kind: 'unset' }))
  card = await h.card(agent.id); publicCard = await summary(h, agent.id)
  assert.deepEqual(card.placement, { kind: 'unset' }); assert.deepEqual(card.tagIds, [common.id])
  assert.deepEqual(publicCard.projectTagIds, [other.id]); assert.deepEqual(publicCard.effectiveTagIds, [common.id, other.id])
  assert.equal(card.progress, before.progress); assert.equal(card.titleOverride, before.titleOverride)
  assert.equal((await h.snapshot()).board.cards.length, 1)
  assert.equal(h.adapter.requests.length, 0); assert.equal(eventsOf(await h.readEvents(agent.id), 'turn/start').length, 0)
})

test('A06/A09/A10/A11/A14 status rename and explicit destination preserve witnessed names and one acceptance per real round', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const h = await (await executionWorkspace(t)).start(), p = await project(h, 'Names before execution')
  const original = await state(h, 'Research before rename'), middle = await state(h, 'Middle'), hold = await state(h, 'Hold')
  const agent = await h.create('product-state-names'); await h.add(agent.id, p.id)
  await h.mutate(choose(await h.card(agent.id), custom(await h.snapshot(), original.id)))
  const selected = await h.card(agent.id), selectedRecord = (await h.history(selected)).records.at(-1)
  assert(selected.placementWitness, 'actual capture must witness selection')
  const entered = latch(), release = latch(); t.after(() => release.release())
  h.adapter.enqueue(async function* (request) { entered.release(); await release.wait(request.signal); yield* textResponse('First product round') })
  prompt(agent); await entered.promise
  let running = (await h.sync(agent.id)).board.cards[0]
  assert.equal(running.origin.kind, 'state'); assert.equal(running.origin.state.statusName, 'Research before rename')
  const frozenOrigin = structuredClone(running.origin)
  await updateState(h, original.id, { name: 'Research renamed' })
  await updateProject(h, projectIn(await h.snapshot(), p.id), { name: 'Names after execution began' })
  const ordering = (await h.snapshot()).board.orders.status
  await h.mutate({ type: 'reorder', dimension: 'status', ids: ['in_progress', 'pending_confirm', 'pending_review', 'accepted', hold.id, middle.id, original.id], expectedRevision: ordering.revision })
  assert.deepEqual((await h.card(agent.id)).origin, frozenOrigin)
  release.release(); await agent.whenIdle(); await h.sync(agent.id)
  const pending = await h.card(agent.id), staleTarget = custom(await h.snapshot(), hold.id)
  assert.equal(pending.status, 'pending_confirm')
  // A renamed status invalidates any destination captured before the rename.
  await updateState(h, hold.id, { name: 'Hold renamed' })
  await h.confirm(agent.id)
  const checked = await h.card(agent.id), historyBefore = await h.history(checked)
  await assert.rejects(h.mutate(review(checked, staleTarget)), reason('CONFLICT'))
  assert.equal((await h.card(agent.id)).decision, null)
  assert.deepEqual((await h.history(checked)).records, historyBefore.records, 'invalid target cannot commit half an acceptance')
  await h.mutate(review(await h.card(agent.id)))
  const accepted = await h.card(agent.id), decision = structuredClone(accepted.decision)
  assert.deepEqual(accepted.placement, { kind: 'builtin', status: 'accepted' })
  await assert.rejects(h.mutate(choose(accepted, { kind: 'custom', target: { statusId: original.id, expectedStatusRevision: 0 } })), reason('CONFLICT'))
  await h.mutate(choose(await h.card(agent.id), custom(await h.snapshot(), hold.id)))
  await h.sync(agent.id); await h.sync(agent.id)
  assert.equal((await h.card(agent.id)).placement.statusId, hold.id)
  assert.deepEqual((await h.card(agent.id)).decision, decision)
  let history = (await h.history(accepted)).records
  assert.equal(history.filter(value => value.kind === 'accepted').length, 1)
  assert.equal(history.find(value => value.id === selectedRecord.id).toState.statusName, 'Research before rename')
  assert.equal(history.find(value => value.kind === 'accepted').origin.state.statusName, 'Research before rename')
  // A second genuine round can explicitly choose its original status (not next column).
  h.adapter.enqueue(textResponse('Second product round')); prompt(agent); await agent.whenIdle(); await h.sync(agent.id)
  const second = await h.card(agent.id)
  assert.equal(second.origin.state.statusId, hold.id)
  await h.confirm(agent.id)
  await h.mutate(review(await h.card(agent.id), custom(await h.snapshot(), hold.id)))
  await h.sync(agent.id)
  history = (await h.history(second)).records
  assert.equal(history.filter(value => value.kind === 'accepted').length, 2)
  assert.equal((await h.card(agent.id)).placement.statusId, hold.id)
  assert.equal(h.adapter.requests.length, 2, 'state choices and acceptance never issue model requests')
})

test('A13/A15/A16/R05 cross-project movement retains the witnessed origin and refuses stale destinations', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const h = await (await executionWorkspace(t)).start(), p = await project(h, 'Source project'), q = await project(h, 'Destination project')
  const a = await state(h, 'Source status'), b = await state(h, 'Destination status'), hold = await state(h, 'Pause here')
  const agent = await h.create('product-cross-project'); await h.add(agent.id, p.id)
  await h.mutate(choose(await h.card(agent.id), custom(await h.snapshot(), a.id)))
  const staleSource = custom(await h.snapshot(), a.id)
  const entered = latch(), release = latch(); t.after(() => release.release())
  h.adapter.enqueue(async function* (request) { entered.release(); await release.wait(request.signal); yield* textResponse('Moved actual round') })
  prompt(agent); await entered.promise; await h.sync(agent.id)
  const running = await h.card(agent.id), oldOrigin = structuredClone(running.origin)
  await h.mutate(move(running, await h.snapshot(), q.id, { kind: 'preserve' }))
  assert.deepEqual((await h.card(agent.id)).origin, oldOrigin)
  assert.deepEqual((await h.card(agent.id)).placement, { kind: 'builtin', status: 'in_progress' })
  release.release(); await agent.whenIdle(); await h.sync(agent.id)
  const pending = await h.card(agent.id)
  await h.confirm(agent.id)
  await h.mutate(review(await h.card(agent.id), { kind: 'stay' }, 'return'))
  const returned = await h.card(agent.id); await h.sync(agent.id)
  assert.equal((await h.card(agent.id)).decision.kind, 'returned')
  assert.equal((await h.card(agent.id)).status, 'in_progress', 'same old completion cannot undo explicit return')
  await assert.rejects(h.mutate(choose(returned, custom(await h.snapshot(), b.id))), reason('INVALID'))
  h.adapter.enqueue(textResponse('New real work in destination project')); prompt(agent); await agent.whenIdle(); await h.sync(agent.id)
  const next = await h.card(agent.id)
  // The placement is board-wide now, so a cross-project move no longer invalidates
  // the witness: the new round still starts inside the same status.
  assert.equal(next.origin.kind, 'state'); assert.equal(next.origin.state.statusId, a.id); assert.equal(next.origin.state.statusName, 'Source status')
  assert.notEqual(next.runtime.episodeId, pending.runtime.episodeId)
  const staleReview = h.envelope(review(next, custom(await h.snapshot(), hold.id)))
  h.adapter.enqueue(textResponse('A newer round invalidates the open confirmation')); prompt(agent); await agent.whenIdle()
  await assert.rejects(h.submit(staleReview), reason('REVIEW_STALE'))
  const newest = await h.card(agent.id)
  assert.equal(newest.decision, null); assert.equal(newest.status, 'pending_confirm')
  await updateState(h, a.id, { name: 'Source status renamed' })
  await h.confirm(agent.id)
  await assert.rejects(h.mutate(review(await h.card(agent.id), staleSource)), reason('CONFLICT'))
  await h.mutate(review(await h.card(agent.id), custom(await h.snapshot(), b.id)))
  const history = (await h.history(newest)).records
  assert.deepEqual(history.find(value => value.kind === 'returned').origin, oldOrigin)
  assert.equal(history.filter(value => value.kind === 'accepted').length, 1)
  assert.equal(history.find(value => value.kind === 'accepted').toState.statusId, b.id)
  assert.equal(h.adapter.requests.length, 3)
})

test('A11/A17 real parked input at final COMMIT aborts acceptance, destination, history and receipt together', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const h = await (await executionWorkspace(t)).start(), agent = await h.create('product-atomic-input')
  h.adapter.enqueue(textResponse('Actual result for atomic destination')); prompt(agent); await agent.whenIdle()
  // Independent actual service/store under test, backed by the same real SDK source.
  const store = new SqliteBoardStore(':memory:'), host = createDshHost(h.ctx), service = new DashboardService(store, host)
  t.after(() => service.close())
  const mutate = (command, requestId) => service.mutate(mutationFor(service, command, requestId))
  await assert.rejects(service.mutate({ ...mutationFor(service, { type: 'resync', sessionId: null }), apiVersion: 1 }), error => error.code === 'UNSUPPORTED_API')
  await mutate({ type: 'create_project', name: 'Atomic project', color: null, tagIds: [] })
  const p = store.read().projects[0]
  await mutate({ type: 'create_label', dimension: 'status', name: 'Delivery', color: null })
  const { binding: inspection } = await service.inspectSession({ sessionId: agent.id })
  await mutate({ type: 'add_card', sessionId: agent.id, projectId: p.id, inspection })
  const checked = store.read().cards[0]
  await mutate({ type: 'confirm_review', ...workflowBinding(checked) })
  const historyBefore = store.history({ sessionId: agent.id, membershipId: checked.membershipId, limit: 100 })
  const command = review(store.read().cards[0], custom({ board: store.read() }, store.read().statuses[0].id)), requestId = randomUUID()
  const commit = store.commit.bind(store); let inserted = false
  store.commit = (receipt, change, fence, sources) => {
    let checks = 0
    return commit(receipt, change, () => {
      if (receipt && ++checks === 2 && !inserted) { inserted = true; agent.inject(userMessage('Parked input at actual final fence')) }
      fence?.()
    }, sources)
  }
  await assert.rejects(mutate(command, requestId), error => error.code === 'REVIEW_STALE')
  assert.equal(inserted, true); assert.equal(store.read().cards[0].decision, null)
  assert.deepEqual(store.read().cards[0].placement, { kind: 'builtin', status: 'pending_review' })
  assert.deepEqual(store.history({ sessionId: agent.id, membershipId: checked.membershipId, limit: 100 }), historyBefore)
  assert.equal(store.wasCommitted({ requestId, digest: digestCommand(command) }), false)
  agent.inbox.clear(); store.commit = commit
  await mutate(command, requestId)
  assert.equal(store.read().cards[0].placement.statusId, command.destination.target.statusId)
  assert.equal(store.history({ sessionId: agent.id, membershipId: checked.membershipId, limit: 100 }).records.filter(value => value.kind === 'accepted').length, 1)
  assert.equal(h.adapter.requests.length, 1)
  // A provider identity replacement is an explicit source-boundary fault, not a
  // manufactured turn. Complete raw replay alone cannot heal a permanent member gap.
  const capture = host.capture.bind(host)
  host.capture = async (...args) => {
    const value = await capture(...args)
    assert(value.source, 'the real adapter must provide source replay before the fault seam')
    return { ...value, source: { ...value.source, sourceIdentity: digestCommand('replacement-provider-identity') } }
  }
  await mutate({ type: 'resync', sessionId: agent.id })
  assert.equal(store.snapshot().cards[0].completionCoverage, 'unavailable')
  let gapCard = store.read().cards[0]
  assert.equal(gapCard.placementWitness, null)
  await assert.rejects(mutate(choose(gapCard, command.destination)), error => error.code === 'UNAVAILABLE')
  h.adapter.enqueue(textResponse('Genuine new round after source-provider replacement')); prompt(agent); await agent.whenIdle()
  await mutate({ type: 'resync', sessionId: agent.id })
  gapCard = store.read().cards[0]
  assert.equal(gapCard.origin.kind, 'unspecified')
  assert.equal(store.snapshot().cards[0].completionCoverage, 'unavailable')
  await assert.rejects(mutate(review(gapCard)), error => error.code === 'REVIEW_STALE')
  assert.equal(h.adapter.requests.length, 2)
})

test('A17/A21 pending never-executed input blocks selection; same-scope reload revokes envelopes and old API explicitly', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const h = await (await executionWorkspace(t)).start(), p = await project(h, 'Reload project'), s = await state(h, 'Initial state')
  const agent = await h.create('product-no-turn'); await h.add(agent.id, p.id)
  const before = await h.card(agent.id), selected = choose(before, custom(await h.snapshot(), s.id))
  agent.inject(userMessage('Input is pending but the real driver has never executed'))
  await assert.rejects(h.mutate(selected), reason('UNAVAILABLE', 'REVIEW_STALE'))
  let card = await h.card(agent.id)
  assert.equal(card.runtime.episodeId, null); assert.equal(card.decision, null); assert.equal(h.adapter.requests.length, 0)
  agent.inbox.clear(); await h.sync(agent.id)
  await h.mutate(choose(await h.card(agent.id), custom(await h.snapshot(), s.id)))
  const receiptCommand = { type: 'create_label', dimension: 'tag', name: 'Receipt before reload', color: null }
  const committedEnvelope = h.envelope(receiptCommand); await h.submit(committedEnvelope)
  card = await h.card(agent.id)
  const oldEnvelope = h.envelope(ownEdit(card, { progress: 'Do not commit after reload' })), oldBinding = workflowBinding(card)
  await h.entry.update({ disabled: true }); await h.entry.update({ disabled: false }); await h.ctx.loader.await(); await h.entry.fiber.await()
  const currentHandshake = await h.invoke('handshake')
  assert.notEqual(currentHandshake.serviceId, h.handshake.serviceId); assert.deepEqual(currentHandshake.scope, h.handshake.scope)
  assert.deepEqual(workflowBinding(await h.card(agent.id)), oldBinding, 'unchanged member and all card CAS revisions still require the new service epoch')
  assert.deepEqual(disposition(await h.card(agent.id)), disposition(card))
  await assert.rejects(h.submit(oldEnvelope), reason('UNAVAILABLE'))
  await assert.rejects(h.submit(committedEnvelope), reason('UNAVAILABLE'), 'receipt lookup must not bypass epoch rejection')
  assert.equal((await h.card(agent.id)).progress, card.progress)
  const rpc = (method, args) => h.ctx.typertGateway.invoke({ namespace: 'sessionDashboard', method, args, peer: h.peer })
  await assert.rejects(rpc('extensionSnapshot', { query: { apiVersion: 1 } }))
  await assert.rejects(rpc('mutate', { mutation: { apiVersion: 1, serviceId: currentHandshake.serviceId, requestId: randomUUID(), command: receiptCommand } }))
  const extensions = h.ctx.get('sessionDashboardExtensions')
  assert.throws(() => extensions.connect(), error => error.code === 'UNSUPPORTED_API')
  assert.throws(() => extensions.connect({ apiVersion: 1 }), error => error.code === 'UNSUPPORTED_API')
  // Prove the stronger invariant independently of Loader's legitimate refresh:
  // fully close/reopen actual SQLite, do not observe through the new instance,
  // and keep board revision, scope and every card CAS byte-for-byte identical.
  const epochPath = join(h.root, 'product-service-epoch.sqlite')
  const firstStore = new SqliteBoardStore(epochPath), firstService = new DashboardService(firstStore, createDshHost(h.ctx))
  t.after(() => firstService.close())
  const boardPayload = () => { const db = new DatabaseSync(epochPath); try { return db.prepare('SELECT payload FROM board WHERE id=1').get().payload } finally { db.close() } }
  const inspected = await firstService.inspectSession({ sessionId: agent.id })
  await firstService.mutate(mutationFor(firstService, { type: 'add_card', sessionId: agent.id, projectId: null, inspection: inspected.binding }))
  const committed = mutationFor(firstService, receiptCommand)
  await firstService.mutate(committed)
  const saved = firstStore.read(), scope = firstStore.identity(), payload = boardPayload()
  const frozenEnvelope = mutationFor(firstService, ownEdit(saved.cards[0], { progress: 'Old epoch with every CAS unchanged' }))
  await firstService.close()
  const reopened = new SqliteBoardStore(epochPath), replacement = new DashboardService(reopened, createDshHost(h.ctx))
  // Order revisions are derived from the single durable tag order, so compare the
  // durable row and every persisted field rather than the writer's working copy.
  assert.deepEqual(reopened.identity(), scope)
  assert.equal(boardPayload(), payload, 'reopening does not rewrite the durable board')
  assert.equal(reopened.read().revision, saved.revision)
  assert.deepEqual(reopened.read().cards, saved.cards, 'every card CAS revision survives byte-for-byte')
  assert.deepEqual(reopened.read().tags, saved.tags)
  assert.deepEqual(reopened.read().orders.status, saved.orders.status)
  assert.deepEqual(reopened.read().preferences, saved.preferences)
  assert.notEqual(replacement.serviceId, frozenEnvelope.serviceId)
  await assert.rejects(replacement.mutate(frozenEnvelope), error => error.code === 'UNAVAILABLE')
  await assert.rejects(replacement.mutate(committed), error => error.code === 'UNAVAILABLE')
  assert.deepEqual(reopened.read().cards, saved.cards, 'old epoch cannot mutate or replay a durable receipt before reinspection')
  assert.equal(h.adapter.requests.length, 0)
  // Close before the workspace teardown runs: Windows refuses to unlink an open
  // SQLite file, and after hooks run in registration order.
  await replacement.close()
})
