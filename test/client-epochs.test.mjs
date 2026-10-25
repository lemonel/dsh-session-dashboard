import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { emptyBoard } from '../lib/shared/model.js'
import { DashboardClient } from '../lib/frontend/client.js'
import { publicHandshake, uiSummary } from '../lib/frontend/extension-view.js'

const ok = value => ({ ok: true, value: structuredClone(value) })
const scope = () => ({ scopeId: randomUUID(), storeId: randomUUID(), recoveryId: randomUUID() })
function handshake(currentScope = scope()) {
  const yes = { available: true, reason: null }, no = { available: false, reason: 'unavailable' }
  return { apiVersion: 2, serviceId: randomUUID(), scope: currentScope, capabilities: { query: yes, events: yes, completionReplay: yes, evidenceCheck: yes, nativeSidebarFilter: no, isolatedExecution: no, externalDelivery: no, projectWorkflow: yes, businessHistory: yes, sessionInspection: yes, sidebarEntry: no } }
}
const snapshot = () => ({ board: emptyBoard(), health: { state: 'ready', message: null, lastSyncAt: 1 } })
function fixture(t) {
  let server = handshake(), fail = false
  const writes = []
  const api = { handshake: async () => { if (fail) throw new Error('connection lost'); return ok(server) }, snapshot: async () => ok(snapshot()), candidates: async () => ok({ items: [], total: 0, nextOffset: null, generation: 'fixture' }), mutate: async input => { writes.push(input); return ok(snapshot()) } }
  const client = new DashboardClient(api, 60000); client.start(); t.after(() => client.stop())
  return { client, writes, get server() { return server }, set server(value) { server = value }, set fail(value) { fail = value } }
}

test('N06 incompatible handshake preserves read-only snapshot but refuses all writes', async t => {
  const h = fixture(t); await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake.serviceId, h.server.serviceId)
  h.server = { ...h.server, apiVersion: 1 }; await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake, null); assert.ok(h.client.getSnapshot().snapshot)
  assert.match(h.client.getSnapshot().extensionError, /不可用/)
  assert.equal(await h.client.mutate({ type: 'create_project', name: 'blocked', color: null, tagIds: [] }), null)
  assert.equal(h.writes.length, 0)
})

test('N06 server incarnation changes renegotiate without losing same-scope draft', async t => {
  const h = fixture(t); await h.client.refresh()
  const saved = { draft: { progress: 'retained' } }; h.client.viewDraft = saved
  h.server = { ...h.server, serviceId: randomUUID() }; await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake.serviceId, h.server.serviceId)
  assert.equal(h.client.viewDraft, saved)
  assert.equal(h.client.getSnapshot().serviceChanged, true)
  assert.equal(await h.client.mutate({ type: 'create_project', name: 'stale epoch', color: null, tagIds: [] }), null)
  assert.equal(h.writes.length, 0)
  h.client.acknowledgeService()
  await h.client.mutate({ type: 'create_project', name: 'explicit new epoch', color: null, tagIds: [] })
  assert.equal(h.writes[0].apiVersion, 2); assert.equal(h.writes[0].serviceId, h.server.serviceId)
  h.fail = true; await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake, null)
  assert.equal(h.client.viewDraft, saved)
  h.fail = false; await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake.serviceId, h.server.serviceId)
})

test('N06 a changed scope stays fail-closed across retries and refuses stale editor writes', async t => {
  const h = fixture(t); await h.client.refresh()
  h.server = handshake(); await h.client.refresh()
  assert.match(h.client.getSnapshot().transportError, /范围|恢复代次/)
  await h.client.refresh()
  assert.equal(h.client.getSnapshot().handshake, null)
  assert.match(h.client.getSnapshot().transportError, /范围|恢复代次/)
  assert.equal(await h.client.mutate({ type: 'create_project', name: 'stale', color: null, tagIds: [] }), null)
  assert.equal(h.writes.length, 0)
})

test('N06 public handshake is detached and deeply frozen instead of exposing cached mutable capability state', () => {
  const source = handshake(), projected = publicHandshake(source)
  assert.notEqual(projected, source); assert.notEqual(projected.scope, source.scope)
  assert.throws(() => { projected.capabilities.query.available = false }, TypeError)
  assert.throws(() => { projected.scope.storeId = randomUUID() }, TypeError)
  assert.equal(source.capabilities.query.available, true)
  assert.equal(publicHandshake(null), null)
  assert.equal(typeof uiSummary, 'function')
})
