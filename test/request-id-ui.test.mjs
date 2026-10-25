import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, webcrypto } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import React from 'react'
import { DashboardClient } from '../lib/frontend/client.js'
import { Dashboard } from '../lib/frontend/Dashboard.js'
import { MembershipDialog } from '../lib/frontend/Membership.js'
import { DashboardExtensions } from '../lib/backend/extensions.js'
import { mutationSchema } from '../lib/shared/commands.js'
import { harness, observation } from './helpers.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://dashboard.test/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ok = value => ({ ok: true, value: structuredClone(value) })
function useCrypto(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto })
}
function fallbackCrypto() {
  let calls = 0
  const source = { get calls() { return calls }, getRandomValues(bytes) { assert.equal(this, source); calls++; return webcrypto.getRandomValues(bytes) } }
  return source
}
async function fixture(t) {
  const h = harness(t), ctx = new Context(), writes = [], inspections = [], events = []
  let extensions
  const fiber = ctx.plugin(scope => { extensions = new DashboardExtensions(scope, h.store, h.service) })
  await fiber.await(); assert.equal(fiber.error, undefined); t.after(() => fiber.dispose())
  const remote = work => async input => {
    try { return ok(await work(input)) } catch (error) { return { ok: false, error: { code: 'dashboard/error', message: error.message, details: { reason: error.code } } } }
  }
  const api = {
    handshake: async () => { events.push('handshake'); return ok(extensions.handshake()) },
    snapshot: remote(() => h.service.snapshot()),
    candidates: remote(query => h.service.candidates(query)),
    inspectSession: remote(async query => { events.push('inspect'); const value = await h.service.inspectSession(query); inspections.push(value); return value }),
    mutate: remote(input => { events.push('mutate'); const parsed = mutationSchema.parse(input); assert.match(parsed.requestId, uuidV4); writes.push(parsed); return h.service.mutate(parsed) }),
  }
  const client = new DashboardClient(api, 60000); t.after(() => client.stop())
  return { ...h, api, client, writes, inspections, events, extensions }
}

// These use the real DashboardClient, mutationSchema, service, and SQLite store;
// only the browser crypto capability and the transport boundary are controlled.
test('missing randomUUID: preferences and ordinary mutation reach mutate with schema-valid v4 IDs', async t => {
  const source = fallbackCrypto(); useCrypto(t, source)
  const f = await fixture(t); f.client.start(); await f.client.refresh()
  const revision = f.store.read().preferences.revision
  f.client.updatePreferences(value => ({ ...value, locations: { ...value.locations, projects: { x: 12, y: 34 } } }))
  assert.equal(await f.client.flushPreferences(), true)
  const result = await f.client.mutate({ type: 'create_project', name: 'HTTP project', color: null, tagIds: [] })
  assert.ok(result)
  assert.deepEqual(f.writes.map(input => input.command.type), ['preferences', 'create_project'])
  assert.equal(new Set(f.writes.map(input => input.requestId)).size, 2)
  assert.equal(f.writes[0].command.expectedRevision, revision)
  assert.deepEqual(f.store.read().preferences.locations.projects, { x: 12, y: 34 })
  assert.equal(f.store.read().projects[0].name, 'HTTP project')
  assert.equal(f.client.getSnapshot().preferenceError, null); assert.equal(f.client.getSnapshot().pending, 0)
  assert.equal(source.calls, 2)
})

test('missing all crypto: zero mutation RPCs, local preferences retained, visible explicit retry succeeds', async t => {
  useCrypto(t, undefined)
  const f = await fixture(t)
  // Seed a project so the only view (项目总览) has something to render while the
  // preference write is refused for the missing crypto capability.
  const project = await f.label('project', 'Retain this project')
  render(React.createElement(Dashboard, { client: f.client, openSession() {} }))
  await waitFor(() => assert.ok(f.client.getSnapshot().preferences))
  await screen.findByRole('article', { name: 'Retain this project' })
  await act(async () => {
    f.client.updatePreferences(value => ({ ...value, entry: 'archive', locations: { ...value.locations, projects: { x: 7, y: 8 } } }))
    assert.equal(await f.client.flushPreferences(), false)
    assert.equal(await f.client.mutate({ type: 'create_project', name: 'Must not send', color: null, tagIds: [] }), null)
  })
  assert.equal(f.events.filter(event => event === 'mutate').length, 0, 'No mutation RPC may be attempted without a secure random source')
  assert.equal(f.writes.length, 0); assert.equal(f.store.read().preferences.entry, 'projects')
  assert.equal(f.client.getSnapshot().preferences.entry, 'archive')
  assert.deepEqual(f.client.getSnapshot().preferences.locations.projects, { x: 7, y: 8 })
  assert.ok(screen.getByText('视图偏好未保存，本地条件仍保留。'))
  assert.equal(f.client.getSnapshot().pending, 0)
  const source = fallbackCrypto()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: source })
  await act(async () => { await f.client.refresh() })
  assert.equal(f.events.filter(event => event === 'mutate').length, 0, 'Capability restoration/read refresh must not automatically retry a write')
  fireEvent.click(screen.getByRole('button', { name: '重试保存偏好', exact: true }))
  await waitFor(() => assert.equal(f.client.getSnapshot().preferenceError, null))
  assert.equal(f.events.filter(event => event === 'mutate').length, 1)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].command.type, 'preferences')
  assert.equal(f.store.read().preferences.entry, 'archive')
  assert.deepEqual(f.store.read().preferences.locations.projects, { x: 7, y: 8 })
  assert.equal(source.calls, 1)
})

test('sidebar Membership fallback submits real inspected binding through schema and service without starting execution', async t => {
  const source = fallbackCrypto(); useCrypto(t, source)
  const f = await fixture(t); f.host.set('new', observation('not_started'), false)
  const project = await f.label('project', 'Membership target'), completed = []
  render(React.createElement(MembershipDialog, { api: f.api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: project.id }, onClose() {}, onChanged: (...args) => { completed.push(args) } }))
  const submit = screen.getByRole('button', { name: '确认加入 / 移动', exact: true })
  await waitFor(() => assert.equal(submit.disabled, false))
  assert.equal(source.calls, 0); assert.equal(f.writes.length, 0)
  fireEvent.click(submit)
  await screen.findByText(/项目成员关系已保存/)
  assert.deepEqual(f.events, ['handshake', 'inspect', 'handshake', 'handshake', 'mutate'])
  assert.equal(f.writes.length, 1); assert.equal(source.calls, 1)
  assert.deepEqual(f.writes[0].command.inspection, f.inspections[0].binding)
  assert.equal(f.writes[0].serviceId, f.service.serviceId)
  assert.equal(f.card('new').projectId, project.id); assert.equal(f.card('new').decision, null)
  assert.equal(f.card('new').runtime.phase, 'not_started'); assert.deepEqual(f.card('new').placement, { kind: 'unset' })
  assert.equal(completed.length, 1); assert.equal(completed[0][1], 'new'); assert.equal(completed[0][2], f.service.serviceId)
})

test('Membership fallback never bypasses submit-time service or scope fences', async t => {
  const source = fallbackCrypto(); useCrypto(t, source)
  const f = await fixture(t); f.host.set('new', observation('not_started'), false)
  const handshake = f.api.handshake
  for (const changed of ['service', 'scope']) {
    f.api.handshake = handshake
    render(React.createElement(MembershipDialog, { api: f.api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: null }, onClose() {}, onChanged() { assert.fail('Fenced writes must not complete') } }))
    const submit = screen.getByRole('button', { name: '确认加入 / 移动', exact: true }); await waitFor(() => assert.equal(submit.disabled, false))
    f.api.handshake = async () => { const current = f.extensions.handshake(); return ok(changed === 'service' ? { ...current, serviceId: randomUUID() } : { ...current, scope: { ...current.scope, recoveryId: randomUUID() } }) }
    fireEvent.click(submit)
    await screen.findByRole('alert')
    assert.equal(f.writes.length, 0); assert.equal(source.calls, 0); assert.equal(f.store.read().cards.length, 0)
    cleanup()
  }
})

test('Membership fallback retains inspection CAS: an intervening board write is rejected rather than rebound', async t => {
  const source = fallbackCrypto(); useCrypto(t, source)
  const f = await fixture(t); f.host.set('new', observation('not_started'), false)
  render(React.createElement(MembershipDialog, { api: f.api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: null }, onClose() {}, onChanged() { assert.fail('Stale inspection must not complete') } }))
  const submit = screen.getByRole('button', { name: '确认加入 / 移动', exact: true }); await waitFor(() => assert.equal(submit.disabled, false))
  await f.label('project', 'Concurrent external write')
  fireEvent.click(submit)
  await screen.findByRole('alert')
  assert.equal(f.writes.length, 1); assert.equal(source.calls, 1)
  assert.deepEqual(f.writes[0].command.inspection, f.inspections[0].binding)
  assert.ok(f.writes[0].command.inspection.boardRevision < f.store.read().revision)
  assert.equal(f.store.read().cards.length, 0); assert.equal(submit.disabled, true)
})
