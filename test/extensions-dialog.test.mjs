import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, HTMLButtonElement: dom.window.HTMLButtonElement })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const { StaticLocaleProvider } = await import('../lib/frontend/i18n.js')
const { ExtensionsDialog } = await import('../lib/frontend/ExtensionsDialog.js')
afterEach(() => { cleanup(); document.body.replaceChildren() })

const localized = child => React.createElement(StaticLocaleProvider, { active: 'zh' }, child)
const entry = (id, extra = {}) => ({ id, name: id, version: null, description: null, requires: [], optional: [], enabled: true, ok: true, problem: null, ...extra })
const load = (extra = {}) => ({ entries: [], mounted: [], failures: [], disabled: [], directory: '/tmp/extensions', available: ['card.facet.v1', 'session.catalog.read', 'session.todos.read', 'session.open.v1'], error: null, errorKind: null, ...extra })
const builtinMounted = (id, name, count, extra = {}) => ({ manifest: { id, name, requires: ['card.facet.v1'], optional: ['session.todos.read'], ...extra }, facets: Array.from({ length: count }, (_, index) => ({ id: `f${index}`, chip: () => null })) })
const open = (value, handlers = {}, builtins = { mounted: [], failures: [], skipped: [] }) => {
  const calls = { toggle: [], reload: 0, close: 0 }
  render(localized(React.createElement(ExtensionsDialog, {
    load: value,
    builtins,
    busy: false,
    onToggle: (id, enabled) => calls.toggle.push([id, enabled]),
    onReload: () => { calls.reload += 1 },
    onClose: () => { calls.close += 1 },
    ...handlers,
  })))
  return calls
}

test('a mounted extension reports its state, capabilities and facet count', () => {
  const mounted = { manifest: { id: 'acme.todo', name: 'acme.todo', requires: ['card.facet.v1'], optional: [] }, facets: [{ id: 'todo', chip: () => null }, { id: 'count', chip: () => null }] }
  open(load({ entries: [entry('acme.todo', { name: '待办扩展', version: '1.2.0', description: '读 todo 投影', requires: ['card.facet.v1'], optional: ['session.todos.read'] })], mounted: [mounted] }))
  const row = screen.getByText('待办扩展').closest('li')
  assert.equal(row.getAttribute('data-state'), 'mounted')
  assert.match(row.textContent, /已挂载 · 2 个 facet/)
  assert.match(row.textContent, /v1\.2\.0/)
  assert.match(row.textContent, /读 todo 投影/)
  const caps = [...row.querySelectorAll('.sd-extcap')]
  assert.deepEqual(caps.map(cap => cap.getAttribute('data-required')), ['true', null], 'required and optional capabilities are distinguishable')
  assert.deepEqual(caps.map(cap => cap.textContent), ['card.facet.v1', 'session.todos.read'])
})

test('disabled, unusable and failed rows each expose why', () => {
  open(load({
    entries: [
      entry('off.ext', { name: '停用的', enabled: false }),
      entry('broken.ext', { name: '坏清单', ok: false, problem: 'index.js is missing' }),
      entry('needy.ext', { name: '缺能力', requires: ['session.open.v1'] }),
    ],
    failures: [{ id: 'needy.ext', name: 'needy.ext', reason: 'unsupported', detail: 'this host does not provide: session.open.v1', missing: ['session.open.v1'] }],
  }))
  assert.equal(screen.getByText('停用的').closest('li').getAttribute('data-state'), 'disabled')
  const broken = screen.getByText('坏清单').closest('li')
  assert.equal(broken.getAttribute('data-state'), 'unusable')
  assert.match(broken.textContent, /index\.js is missing/)
  const needy = screen.getByText('缺能力').closest('li')
  assert.equal(needy.getAttribute('data-state'), 'unsupported')
  assert.match(needy.textContent, /this host does not provide: session\.open\.v1/)
})

test('the toggle asks for the opposite of the current state', () => {
  const calls = open(load({ entries: [entry('a.ext', { name: 'A' }), entry('b.ext', { name: 'B', enabled: false })] }))
  fireEvent.click(within(screen.getByText('A').closest('li')).getByRole('button', { name: '停用' }))
  fireEvent.click(within(screen.getByText('B').closest('li')).getByRole('button', { name: '启用' }))
  assert.deepEqual(calls.toggle, [['a.ext', false], ['b.ext', true]])
})

test('a list failure is announced with a retry that asks for a reload', () => {
  const calls = open(load({ entries: [], error: 'extension list failed: HTTP 500', errorKind: 'failed' }))
  const alert = screen.getByRole('alert')
  assert.match(alert.textContent, /HTTP 500/)
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
  assert.equal(calls.reload, 1)
  fireEvent.click(screen.getByRole('button', { name: '重新加载扩展' }))
  assert.equal(calls.reload, 2)
})

test('the manager shows which capabilities this host grants', () => {
  open(load({ available: ['card.facet.v1', 'session.todos.read'] }))
  const legend = document.querySelector('[aria-label="本宿主提供："]')
  assert.ok(legend, 'the legend is labelled')
  const caps = [...legend.querySelectorAll('.sd-extcap')]
  assert.equal(caps.length, 4, 'every known capability is listed, granted or not')
  assert.deepEqual(caps.map(cap => [cap.textContent, cap.getAttribute('data-granted')]), [
    ['card.facet.v1', 'true'],
    ['session.catalog.read', 'false'],
    ['session.todos.read', 'true'],
    ['session.open.v1', 'false'],
  ])
})

test('a Host without extension routes says a restart is what fixes it', () => {
  const calls = open(load({ entries: [], error: 'unavailable', errorKind: 'unavailable' }))
  const alert = screen.getByRole('alert')
  assert.match(alert.textContent, /还没有注册扩展路由/)
  assert.match(alert.textContent, /重启一次 DSH/)
  assert.doesNotMatch(alert.textContent, /404/, 'the operator gets a cause, not a transport code')
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
  assert.equal(calls.reload, 1)
})

test('an empty directory and an unloaded list each say so', () => {
  open(load())
  assert.match(screen.getByText(/扩展目录里还没有扩展/).textContent, /扩展目录里还没有扩展/)
  cleanup()
  open(null)
  assert.ok(screen.getByText('正在加载…'))
})

test('built-in extensions are listed with their state, a 内置 badge and a working toggle', () => {
  const calls = open(load(), {}, { mounted: [builtinMounted('builtin.agents', '运行中的子 Agent', 1), builtinMounted('builtin.todos', '本轮待办', 1)], failures: [], skipped: [] })
  const row = screen.getByText('运行中的子 Agent').closest('li')
  assert.equal(row.getAttribute('data-state'), 'mounted')
  assert.equal(row.getAttribute('data-builtin'), 'true')
  assert.match(row.textContent, /内置/)
  assert.match(row.textContent, /已挂载 · 1 个 facet/)
  const caps = [...row.querySelectorAll('.sd-extcap:not([data-builtin])')]
  assert.deepEqual(caps.map(cap => [cap.textContent, cap.getAttribute('data-required')]), [['card.facet.v1', 'true'], ['session.todos.read', null]])
  fireEvent.click(within(row).getByRole('button', { name: '停用' }))
  assert.deepEqual(calls.toggle, [['builtin.agents', false]], 'a built-in can be switched off like any extension')
})

test('a switched-off built-in stays visible and offers to come back', () => {
  const calls = open(load(), {}, { mounted: [], failures: [], skipped: [{ id: 'builtin.agents', name: '运行中的子 Agent', version: '1', requires: ['card.facet.v1'], optional: [] }] })
  const row = screen.getByText('运行中的子 Agent').closest('li')
  assert.equal(row.getAttribute('data-state'), 'disabled')
  assert.match(row.textContent, /已停用/)
  fireEvent.click(within(row).getByRole('button', { name: '启用' }))
  assert.deepEqual(calls.toggle, [['builtin.agents', true]])
})

test('the footer counts built-ins and directory extensions in one number', () => {
  const mounted = { manifest: { id: 'acme.demo', name: 'acme.demo', requires: ['card.facet.v1'] }, facets: [{ id: 'demo', chip: () => null }] }
  open(load({ entries: [entry('acme.demo', { name: '示例扩展', requires: ['card.facet.v1'] })], mounted: [mounted] }), {}, { mounted: [builtinMounted('builtin.agents', '运行中的子 Agent', 1), builtinMounted('builtin.todos', '本轮待办', 1)], failures: [], skipped: [] })
  assert.match(document.querySelector('.sd-extfoot').textContent, /已挂载 3 个扩展 \/ 3 个 facet/)
})

test('a built-in that could not mount reports the same detail a directory one would', () => {
  open(load(), {}, { mounted: [], failures: [{ id: 'builtin.agents', name: '运行中的子 Agent', reason: 'unsupported', detail: 'this host does not provide: card.facet.v1', missing: ['card.facet.v1'] }], skipped: [] })
  const row = screen.getByText('运行中的子 Agent').closest('li')
  assert.equal(row.getAttribute('data-state'), 'unsupported')
  assert.match(row.textContent, /does not provide: card\.facet\.v1/)
})

test('closing goes back to the dashboard', () => {
  const calls = open(load())
  fireEvent.click(screen.getByRole('button', { name: '关闭仪表板扩展' }))
  assert.equal(calls.close, 1)
})
