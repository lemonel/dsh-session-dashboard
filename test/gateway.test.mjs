import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context, symbols } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { SessionDashboardRemote } from '../lib/backend/remote.js'
import { TYPERT } from '../lib/backend/typert.host.js'
import { snapshotSchema, candidateSchema } from '../lib/shared/model.js'
import { harness, observation, mutationFor, workflowBinding, replayFixture } from './helpers.mjs'
import { capabilities, mountGatewayPrerequisites } from './tools/sdk.mjs'

async function setup(t) {
  const h = harness(t), ctx = new Context(), fibers = []
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await(); assert.equal(fiber.error, undefined); return fiber }
  let connection, connectionScope
  const connectionFiber = await mount(scope => {
    connectionScope = scope
    // Only HTTP credential validation is a fixture boundary; use the real Service and Peer.
    connection = new HostConnectionService(scope, [], { isAuthenticated: request => new Headers(request.headers).get('x-fixture-browser') === 'authenticated', authenticateApi: () => undefined })
  })
  const peer = capabilities.principalPeers ? connection.browserPeer : connection.operator
  const replacePeer = value => { if (capabilities.principalPeers) connection.browserPeer = value; else connection.operator = value }
  const replaceConnection = () => connectionScope.reflect.set('connection', capabilities.principalPeers ? { browserPeer: peer } : { operator: peer })
  t.after(async () => { replacePeer(peer); for (const fiber of fibers.reverse()) await fiber.dispose() })
  await mount(Registry)
  ctx.typert.register(TYPERT)
  await mount(SessionDashboardRemote, h.service)
  const access = await mountGatewayPrerequisites(ctx); if (access) fibers.push(access)
  await mount(Gateway, {})
  assert(ctx.typertGateway, 'actual installed Gateway must mount')
  const invoke = (method, args = {}, extra = {}) => ctx.typertGateway.invoke({ namespace: 'sessionDashboard', method, args, peer, ...extra })
  const carrier = connection.createSharedFetchHandler('/api')
  const wire = async (method, args = {}) => {
    const rpcId = randomUUID(), endpoint = `sessionDashboard/${method}`
    const admission = connection.admit({ headers: new Headers({ host: 'localhost', 'x-fixture-browser': 'authenticated' }) })
    assert.equal(admission.peer, peer)
    const response = await carrier.fetch(new Request(`http://localhost/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) }), admission.peer)
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, rpcId)
    return envelope.result
  }
  return { ...h, ctx, peer, invoke, replacePeer, replaceConnection, connectionFiber, connection, wire }
}

test('real Connection service proxy reads share one service identity, and carrier RPC reaches board methods', async t => {
  const h = await setup(t), one = h.ctx.get('connection'), two = h.ctx.get('connection')
  assert.notEqual(one, two, 'Cordis intentionally creates a fresh proxy on every read')
  assert.equal(one[symbols.original], two[symbols.original])
  assert.equal(h.connection.admit({ headers: new Headers({ host: 'localhost' }) }).rejection, 401)
  assert.equal(h.connection.admit({ headers: new Headers({ host: 'attacker.invalid', 'x-fixture-browser': 'authenticated' }) }).rejection, 403)
  const snapshot = await h.wire('snapshot')
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.equal(snapshotSchema.parse(snapshot.value).board.cards.length, 0)
  const added = await h.wire('mutate', { mutation: mutationFor(h.service, { type: 'create_project', name: 'Carrier project', color: null, tagIds: [] }) })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.equal(snapshotSchema.parse(added.value).board.projects[0].name, 'Carrier project')
})

test('real Cordis+strict Typert Gateway dispatch uses authenticated invocation, validates results', async t => {
  const h = await setup(t)
  const initial = await h.invoke('snapshot')
  assert.equal(snapshotSchema.parse(initial).board.cards.length, 0)
  h.host.set('a', observation(), false)
  const page = await h.invoke('candidates', { query: { search: '', offset: 0, limit: 10 } })
  assert.equal(candidateSchema.parse(page.items[0]).sessionId, 'a')
  const { binding: inspection } = await h.invoke('inspectSession', { query: { sessionId: 'a' } })
  const add = mutationFor(h.service, { type: 'add_card', sessionId: 'a', projectId: null, inspection })
  const added = await h.invoke('mutate', { mutation: add })
  assert.equal(added.board.cards[0].status, 'pending_confirm')
  const card = added.board.cards[0]
  h.host.setSource('a', replayFixture('a', card.runtime))
  const confirmed = (await h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'confirm_review', ...workflowBinding(card) }) })).board.cards[0]
  const accepted = await h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'review', ...workflowBinding(confirmed), action: 'accept', confirmed: true, destination: { kind: 'stay' } }) })
  assert.equal(accepted.board.cards[0].status, 'accepted')
})

test('real Gateway rejects alien/forged peer and missing invocation, not just arbitrary session ids', async t => {
  const h = await setup(t)
  await assert.rejects(h.invoke('snapshot', {}, { peer: { ...h.peer } }), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
  if (capabilities.principalPeers) {
    const { Peer } = await import('@deepseek-ai/dsh-client-connection')
    const alienOwner = new Peer(h.ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    await assert.rejects(h.invoke('snapshot', {}, { peer: alienOwner }), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
    await alienOwner.dispose()
  }
  await assert.rejects(h.ctx.get('sessionDashboard').snapshot(), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(h.invoke('snapshot', {}, { signal: abort.signal }))
})

test('same-peer service replacement and unavailable connection both revoke pending writes before COMMIT', async t => {
  for (const mode of ['replace', 'unload']) {
    const h = await setup(t)
    h.host.set('a', observation(), false)
    const { binding: inspection } = await h.invoke('inspectSession', { query: { sessionId: 'a' } })
    const original = h.host.capture.bind(h.host)
    let captured = false
    h.host.capture = async id => {
      const value = await original(id); captured = true
      if (mode === 'replace') h.replaceConnection()
      else await h.connectionFiber.dispose()
      return value
    }
    await assert.rejects(h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'add_card', sessionId: 'a', projectId: null, inspection }) }), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
    assert.equal(captured, true, 'the real browser was authorized before its connection changed')
    assert.equal(h.store.read().cards.length, 0)
  }
})

test('principal browser lifetime and carrier cancellation are rechecked after awaited capture', async t => {
  for (const mode of capabilities.principalPeers ? ['cancel', 'peer-dispose'] : ['cancel']) {
    const h = await setup(t), abort = new AbortController()
    h.host.set('a', observation(), false)
    const { binding: inspection } = await h.invoke('inspectSession', { query: { sessionId: 'a' } })
    const original = h.host.capture.bind(h.host)
    let captured = false
    h.host.capture = async id => { const value = await original(id); captured = true; if (mode === 'cancel') abort.abort(); else await h.peer.dispose(); return value }
    await assert.rejects(h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'add_card', sessionId: 'a', projectId: null, inspection }) }, { signal: abort.signal }))
    assert.equal(captured, true); assert.equal(h.store.read().cards.length, 0)
  }
})

test('strict RPC schema rejects additional wire args, arbitrary fields and missing human confirmation', async t => {
  const h = await setup(t)
  await assert.rejects(h.invoke('snapshot', { projectId: 'anything' }))
  await assert.rejects(h.invoke('candidates', { query: { search: '', offset: 0, limit: 101 } }))
  await assert.rejects(h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'set_status', sessionId: 'a', status: 'accepted' }) }))
  await assert.rejects(h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'remove_card', sessionId: 'a', membershipId: randomUUID(), expectedMetadataRevision: 0 }) }))
})

test('authority is rechecked after async host capture before commit', async t => {
  const h = await setup(t)
  h.host.set('a', observation(), false)
  const { binding: inspection } = await h.invoke('inspectSession', { query: { sessionId: 'a' } })
  const original = h.host.capture.bind(h.host)
  h.host.capture = async id => { const value = await original(id); h.replacePeer({ ...h.peer }); return value }
  await assert.rejects(h.invoke('mutate', { mutation: mutationFor(h.service, { type: 'add_card', sessionId: 'a', projectId: null, inspection }) }), error => error.code === 'dashboard/error' && error.details.reason === 'FORBIDDEN')
  assert.equal(h.store.read().cards.length, 0)
})
