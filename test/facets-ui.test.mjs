import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { FacetStrip, SessionFacet } from '../lib/frontend/facets.js'

import { StaticLocaleProvider } from '../lib/frontend/i18n.js'
import { unknownRuntime } from '../lib/shared/model.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })

const localized = child => React.createElement(StaticLocaleProvider, { active: 'zh' }, child)
function card(extra = {}) {
  return { sessionId: 'parent', membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null }, hostTitle: 'parent', titleOverride: null, workspace: '/w', projectId: 'p', tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'unset' }, origin: null, placementWitness: null, workflowRevision: 0, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, attention: 'none', ...extra.runtime }, decision: null, joinedAt: 1, activityAt: null, updatedAt: 1, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0, ...extra }
}
/** Minimal Client Session Controller list stand-in: one root with two children. */
function catalog(rows) {
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  return { getSnapshot: () => ({ ids: rows.map(row => row.id), byId }), subscribe: () => () => {} }
}
const translator = key => key

test('a facet without a detail is a read-only chip, never a dead button', () => {
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet: { id: 'count', chip: { icon: '⛓', count: 2, tone: 'business', title: 'agents' } } }))))
  const chip = screen.getByTitle('agents')
  assert.equal(chip.tagName, 'SPAN')
  assert.equal(screen.queryByRole('button'), null)
  assert.match(chip.textContent, /2/)
})

test('opening a facet renders its rows in one host-owned panel and Escape closes it', async () => {
  const facet = { id: 'agents', chip: { count: 2, title: 'child agents' }, detail: { kind: 'rows', rows: [
    { id: 'a', title: '第一个子 Agent', meta: '运行中', state: 'running' },
    { id: 'b', title: '第二个子 Agent', meta: '已停止', state: 'idle' },
  ] } }
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet }))))
  const chip = screen.getByRole('button', { name: 'child agents' })
  assert.equal(chip.getAttribute('aria-expanded'), 'false')
  await act(async () => { fireEvent.click(chip) })
  const panel = await screen.findByRole('group', { name: 'child agents' })
  assert.deepEqual([...panel.querySelectorAll('.sd-facet-title')].map(node => node.textContent), ['第一个子 Agent', '第二个子 Agent'])
  assert.equal(panel.querySelectorAll('.sd-facet-row[data-state=running]').length, 1)
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
  await waitFor(() => assert.equal(screen.queryByRole('group', { name: 'child agents' }), null))
})

test('a strip keeps one panel open: opening the second facet closes the first', async () => {
  const first = { id: 'one', chip: { text: 'one', count: 1, title: 'first facet' }, detail: { kind: 'rows', rows: [{ id: 'x', title: 'row one' }] } }
  const second = { id: 'two', chip: { text: 'two', count: 3, title: 'second facet' }, detail: { kind: 'rows', rows: [{ id: 'y', title: 'row two' }] } }
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet: first }), React.createElement(SessionFacet, { facet: second }))))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'first facet' })) })
  assert.ok(screen.getByRole('group', { name: 'first facet' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'second facet' })) })
  await waitFor(() => assert.equal(screen.queryByRole('group', { name: 'first facet' }), null))
  assert.ok(screen.getByRole('group', { name: 'second facet' }))
})

test('an async detail loads on open only and reports an empty list through the host copy', async () => {
  let loads = 0
  const facet = { id: 'lazy', chip: { text: 'lazy', count: 1, title: 'lazy facet' }, detail: () => { loads += 1; return Promise.resolve({ kind: 'rows', rows: [], empty: '没有子 Agent' }) } }
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet }))))
  assert.equal(loads, 0, 'a closed panel reads nothing')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'lazy facet' })) })
  const panel = await screen.findByRole('group', { name: 'lazy facet' })
  await waitFor(() => assert.match(panel.textContent, /没有子 Agent/))
  assert.equal(loads, 1)
})

test('a chip near the bottom of the viewport opens its panel upward so it stays visible', async () => {
  const facet = { id: 'low', chip: { count: 1, title: 'low facet' }, detail: { kind: 'rows', rows: [{ id: 'r', title: 'row' }] } }
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet }))))
  const chip = screen.getByRole('button', { name: 'low facet' })
  const original = dom.window.Element.prototype.getBoundingClientRect
  const height = Object.getOwnPropertyDescriptor(dom.window, 'innerHeight')
  dom.window.Element.prototype.getBoundingClientRect = () => ({ left: 100, right: 160, top: 380, bottom: 396, width: 60, height: 16, x: 100, y: 380, toJSON() {} })
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 400 })
  try {
    await act(async () => { fireEvent.click(chip) })
    const panel = await screen.findByRole('group', { name: 'low facet' })
    assert.notEqual(panel.style.bottom, '', 'the panel anchors to the chip top when the row is low')
    assert.equal(panel.style.top, '')
    assert.notEqual(panel.style.maxHeight, '', 'the height is clamped to the room above')
  } finally {
    dom.window.Element.prototype.getBoundingClientRect = original
    if (height === undefined) delete dom.window.innerHeight
    else Object.defineProperty(dom.window, 'innerHeight', height)
  }
})

test('the press that dismisses a panel does not also activate the surface behind it', async () => {
  const facet = { id: 'dismiss', chip: { count: 1, title: 'dismissable' }, detail: { kind: 'rows', rows: [] } }
  render(localized(React.createElement(FacetStrip, null, React.createElement(SessionFacet, { facet }))))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'dismissable' })) })
  await screen.findByRole('group', { name: 'dismissable' })
  // A project card stands in for the passive surface under the panel: it folds
  // itself on any click that is not a button, so the dismissing press must not
  // reach it.
  const card = document.createElement('div')
  document.body.append(card)
  let activated = 0
  card.addEventListener('click', () => { activated += 1 })
  await act(async () => { fireEvent.pointerDown(card) })
  await waitFor(() => assert.equal(screen.queryByRole('group', { name: 'dismissable' }), null))
  await act(async () => { fireEvent.click(card) })
  assert.equal(activated, 0, 'the click that dismisses the panel is consumed')
  await act(async () => { fireEvent.click(card) })
  assert.equal(activated, 1, 'the next deliberate click still works')
  card.remove()
})

import { agentsExtension, todosExtension } from '../lib/shared/extensions/index.js'
import { mountExtension } from '../lib/shared/extensions/contract.js'

/** Catalogue rows reduced to the extension contract, from display-shaped fixtures. */
function contractCatalog(rows) {
  const byId = Object.fromEntries(rows.map(row => [row.id, {
    id: row.id,
    title: row.displayTitle ?? row.id,
    parentId: row.parentId ?? null,
    running: row.running === true,
    updatedAt: row.updatedAt ?? 0,
    ...row.projectionValues === undefined ? {} : { projectionValues: row.projectionValues },
  }]))
  return { getSnapshot: () => ({ byId }) }
}
const ALL = ['card.facet.v1', 'session.catalog.read', 'session.todos.read']
const mount = (module, rows, available = ALL) => mountExtension(module, new Set(available), { translate: translator, catalog: contractCatalog(rows) })
const view = (extra = {}) => ({ sessionId: 'parent', title: 'parent', projectId: 'p', activeAgents: 0, ...extra })
const spec = (mounted, id) => {
  assert.ok(mounted.facets, 'the extension mounted')
  return mounted.facets.find(item => item.id === id)
}

test('the agent facet counts the Host fact and lists only running child agents from the catalogue', async () => {
  const rows = [
    { id: 'parent', displayTitle: 'parent', running: true },
    { id: 'child-a', displayTitle: '检查日志', running: true, parentId: 'parent', updatedAt: 2 },
    { id: 'child-b', displayTitle: '汇总结果', running: false, parentId: 'parent', updatedAt: 3 },
    { id: 'grand', displayTitle: '孙 Agent', running: true, parentId: 'child-a', updatedAt: 1 },
    { id: 'other', displayTitle: '无关会话', running: true, parentId: 'unrelated', updatedAt: 4 },
  ]
  const facet = spec(mount(agentsExtension, rows), 'agents')
  const chip = facet.chip(view({ activeAgents: 2 }))
  assert.equal(chip.count, 2)
  const list = await facet.rows(view({ activeAgents: 2 }))
  assert.deepEqual(list.slice(0, 2).map(row => row.title), ['检查日志', '孙 Agent'], 'children come before their own children, newest first')
  assert.deepEqual(list.slice(0, 2).map(row => row.state), ['running', 'running'])
  assert.equal(list.length, 3, 'one muted line reports the history it left out')
  assert.equal(list[2].state, 'idle')
})

test('the todo facet counts this turn and renders its three states', async () => {
  const rows = [{ id: 'parent', displayTitle: 'parent', running: true, projectionValues: { todos: [
    { content: '读代码', status: 'completed' },
    { content: '改布局', status: 'in_progress' },
    { content: '跑测试', status: 'pending' },
  ] } }]
  const facet = spec(mount(todosExtension, rows), 'todos')
  const chip = facet.chip(view())
  assert.equal(chip.count, 1)
  assert.equal(chip.total, 3)
  const list = await facet.rows(view())
  assert.deepEqual(list.map(row => row.title), ['读代码', '改布局', '跑测试'])
  assert.deepEqual(list.map(row => row.state), ['done', 'doing', 'pending'])
})

test('a session without a plan contributes no todo chip at all', () => {
  const none = spec(mount(todosExtension, [{ id: 'parent', displayTitle: 'p', running: true }]), 'todos')
  assert.equal(none.chip(view()), null)
  const empty = spec(mount(todosExtension, [{ id: 'parent', displayTitle: 'p', running: true, projectionValues: { todos: [] } }]), 'todos')
  assert.equal(empty.chip(view()), null)
})

test('a running subagent carries its own plan as nested rows', async () => {
  const rows = [
    { id: 'parent', displayTitle: 'parent', running: true },
    { id: 'child', displayTitle: '子 Agent', running: true, parentId: 'parent', updatedAt: 1, projectionValues: { todos: [{ content: '子任务 A', status: 'in_progress' }] } },
  ]
  const facet = spec(mount(agentsExtension, rows), 'agents')
  const list = await facet.rows(view({ activeAgents: 1 }))
  assert.deepEqual(list[0].children.map(row => row.title), ['子任务 A'])
  assert.equal(list[0].children[0].state, 'doing')
})

test('no running agents means no chip and no empty pill', () => {
  const facet = spec(mount(agentsExtension, []), 'agents')
  assert.equal(facet.chip(view({ activeAgents: 0 })), null)
})

test('without the catalogue capability the agent chip degrades to a read-only count', () => {
  const mounted = mountExtension(agentsExtension, new Set(['card.facet.v1']), { translate: translator })
  const facet = spec(mounted, 'agents')
  assert.equal(facet.chip(view({ activeAgents: 3 })).count, 3)
  assert.equal(facet.rows, undefined, 'no catalogue means no panel to open')
})

test('an undeclared namespace is absent from the host, not denied at call time', () => {
  const calls = []
  const extension = {
    manifest: { id: 'probe.undeclared', name: 'probe', requires: ['card.facet.v1'] },
    facets(host) {
      calls.push({ hasTodos: 'todos' in host, todos: host.todos, catalog: host.catalog, open: host.open })
      return [{ id: 'probe', chip: () => null }]
    },
  }
  const mounted = mountExtension(extension, new Set(['card.facet.v1', 'session.catalog.read', 'session.todos.read', 'session.open.v1']), {
    translate: translator,
    catalog: contractCatalog([]),
    open: () => {},
  })
  assert.ok(mounted.facets, 'it still mounts: it only declared the facet capability')
  assert.deepEqual(calls[0], { hasTodos: false, todos: undefined, catalog: undefined, open: undefined })
})

test('an extension that needs a capability this host cannot grant does not mount', () => {
  const needy = { manifest: { id: 'probe.needy', name: 'needy', requires: ['session.open.v1'] }, facets: () => [] }
  const mounted = mountExtension(needy, new Set(['card.facet.v1']), { translate: translator })
  assert.equal(mounted.facets, undefined)
  assert.equal(mounted.reason, 'unsupported')
  assert.deepEqual(mounted.missing, ['session.open.v1'])
  assert.match(mounted.detail, /session\.open\.v1/)
})

test('a throwing extension is reported, never propagated', () => {
  const broken = { manifest: { id: 'probe.broken', name: 'broken', requires: ['card.facet.v1'] }, facets() { throw new Error('boom') } }
  const mounted = mountExtension(broken, new Set(['card.facet.v1']), { translate: translator })
  assert.equal(mounted.reason, 'failed')
  assert.match(mounted.detail, /boom/)
})

test('a malformed manifest or facet id is rejected before anything runs', () => {
  const badManifest = { manifest: { id: 'Bad Id', name: 'x', requires: [] }, facets: () => [] }
  assert.equal(mountExtension(badManifest, new Set(), { translate: translator }).reason, 'invalid')
  const badFacet = { manifest: { id: 'probe.bad', name: 'x', requires: [] }, facets: () => [{ id: '', chip: () => null }] }
  assert.equal(mountExtension(badFacet, new Set(), { translate: translator }).reason, 'invalid')
  const unknownCapability = { manifest: { id: 'probe.unknown', name: 'x', requires: ['card.facet.v9'] }, facets: () => [] }
  assert.equal(mountExtension(unknownCapability, new Set(), { translate: translator }).reason, 'invalid')
})
