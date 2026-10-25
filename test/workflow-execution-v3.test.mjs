import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { denyNetwork, executionWorkspace, prompt, textResponse, userMessage } from './tools/execution-host.mjs'

const binding = card => ({ sessionId: card.sessionId, membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision, expectedLifecycleRevision: card.lifecycleRevision, expectedWorkflowRevision: card.workflowRevision, episodeId: card.runtime.episodeId })
const target = state => ({ statusId: state.id, expectedStatusRevision: state.revision })
const stale = error => error.code === 'dashboard/error' && ['CONFLICT', 'REVIEW_STALE', 'UNAVAILABLE', 'INVALID'].includes(error.details.reason)

test('cold fsynced replay preserves complete readonly evidence without granting live review or starting a model', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  const agent = await h.create('real-v3-cold-replay')
  await h.add(agent.id)
  const original = await h.invoke('extensionSnapshot', { query: { apiVersion: 2 } })
  await h.entry.fiber.dispose()
  h.adapter.enqueue(textResponse('Durable offline first result'), textResponse('Durable offline second result'))
  prompt(agent, 'Offline first round'); await agent.whenIdle()
  prompt(agent, 'Offline second round'); await agent.whenIdle()
  const raw = await h.readEvents(agent.id)
  assert.equal(raw.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2)
  await h.close()
  const restarted = await workspace.start()
  await restarted.sync(agent.id)
  const snapshot = await restarted.invoke('extensionSnapshot', { query: { apiVersion: 2 } }), card = snapshot.cards[0]
  assert.deepEqual(snapshot.handshake.scope, original.handshake.scope)
  assert.equal(card.membershipId, original.cards[0].membershipId)
  assert.equal(card.sync, 'synced'); assert.equal(card.sourceLive, false)
  assert.equal(card.completionCoverage, 'complete'); assert.match(card.completionEvidenceDigest, /^[a-f0-9]{64}$/)
  assert.equal(card.sourceCursor, raw.length)
  const recovered = await restarted.invoke('extensionEvents', { query: { apiVersion: 2, after: original.highWatermark, limit: 200 } })
  assert.equal(recovered.events.filter(event => event.kind === 'completed').length, 2)
  await assert.rejects(restarted.review(agent.id), error => error.code === 'dashboard/error' && error.details.reason === 'REVIEW_STALE')
  const repeated = await restarted.invoke('extensionSnapshot', { query: { apiVersion: 2 } })
  assert.equal(repeated.cards[0].completionCoverage, 'complete'); assert.equal(repeated.cards[0].completionEvidenceDigest, card.completionEvidenceDigest)
  assert.equal(restarted.adapter.requests.length, 0); assert.equal(restarted.ctx.agents.list().length, 0)
})

test('real AgentLoop plus authenticated Gateway binds witnessed source and atomically accepts into arbitrary custom destination', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  await h.mutate({ type: 'create_project', name: 'Real project', color: null, tagIds: [] })
  const project = (await h.snapshot()).board.projects[0]
  for (const name of ['Research', 'Paused work', 'Delivery']) await h.mutate({ type: 'create_label', dimension: 'status', name, color: null })
  const statuses = (await h.snapshot()).board.statuses, research = statuses[0], delivery = statuses[2], agent = await h.create('real-v3-workflow')
  await h.add(agent.id, project.id)
  let card = await h.card(agent.id)
  await h.mutate({ type: 'choose_state', ...binding(card), selection: { kind: 'custom', target: target(research) } })
  card = await h.card(agent.id); const witness = card.placementWitness
  assert(witness); assert.equal(card.placement.statusId, research.id)
  h.adapter.enqueue(textResponse('Real completed research result')); prompt(agent); await agent.whenIdle()
  card = (await h.sync(agent.id)).board.cards[0]
  assert.equal(card.status, 'pending_confirm'); assert.equal(card.origin.kind, 'state'); assert.equal(card.origin.state.statusName, 'Research')
  assert(card.runtime.episodeOrder > witness.cursor)
  await h.mutate({ type: 'confirm_review', ...binding(card) })
  card = await h.card(agent.id)
  const command = { type: 'review', ...binding(card), action: 'accept', confirmed: true, destination: { kind: 'custom', target: target(delivery) } }, requestId = randomUUID()
  const accepted = (await h.mutate(command, requestId)).board.cards[0]
  assert.equal(accepted.placement.kind, 'custom'); assert.equal(accepted.placement.statusId, delivery.id); assert.equal(accepted.status, 'accepted')
  await h.mutate(command, requestId); await h.sync(agent.id)
  const history = await h.invoke('history', { query: { sessionId: agent.id, membershipId: accepted.membershipId, limit: 100 } })
  assert.equal(history.records.filter(record => record.kind === 'accepted').length, 1)
  assert.equal(history.records.find(record => record.kind === 'accepted').toState.statusName, 'Delivery')
  assert.equal(h.adapter.requests.length, 1, 'state destination never starts the next execution')
  h.adapter.enqueue(textResponse('Actual second independent execution')); prompt(agent); await agent.whenIdle()
  const next = (await h.sync(agent.id)).board.cards[0]
  assert.equal(next.origin.state.statusId, delivery.id); assert.notEqual(next.runtime.episodeId, card.runtime.episodeId)
  await assert.rejects(h.mutate(command), stale)
})

test('real parked input, cancellation and reload cannot reuse workflow or service authority', { timeout: 30000 }, async t => {
  denyNetwork(t)
  const workspace = await executionWorkspace(t), h = await workspace.start()
  await h.mutate({ type: 'create_project', name: 'Initial safety', color: null, tagIds: [] })
  const project = (await h.snapshot()).board.projects[0]
  await h.mutate({ type: 'create_label', dimension: 'status', name: 'Custom', color: null })
  const status = (await h.snapshot()).board.statuses[0]
  const agent = await h.create('real-v3-input'); await h.add(agent.id, project.id)
  const checked = await h.card(agent.id), command = { type: 'choose_state', ...binding(checked), selection: { kind: 'custom', target: target(status) } }
  const observer = createDshHost(h.ctx), cut = await observer.capture(agent.id, true)
  agent.inject(userMessage('Pending without waking the real driver'))
  assert.equal(agent.status, 'idle'); assert.equal(cut.validate(), false); cut.dispose(); observer.close()
  await assert.rejects(h.mutate(command), stale)
  assert.equal(h.adapter.requests.length, 0)
  agent.inbox.clear()
  const current = (await h.sync(agent.id)).board.cards[0]
  await h.mutate({ ...command, ...binding(current) })
  assert.equal((await h.card(agent.id)).placement.kind, 'custom')
  const oldEnvelope = { apiVersion: 2, serviceId: (await h.invoke('handshake')).serviceId, requestId: randomUUID(), command: { type: 'resync', sessionId: agent.id } }
  await h.entry.update({ disabled: true }); await h.entry.update({ disabled: false }); await h.ctx.loader.await(); await h.entry.fiber.await()
  await assert.rejects(h.invoke('mutate', { mutation: oldEnvelope }), stale)
  assert.equal(h.adapter.requests.length, 0)
})
