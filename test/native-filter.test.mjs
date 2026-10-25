import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { registerSidebarMembershipFilter } from '../lib/frontend/native-filter.js'

test('the native sidebar filter marks dashboard rows and toggles their visibility attribute', async () => {
  const dom = new JSDOM('<body><div data-slot="sidebar"><div class="header-actions"><button class="icon" aria-label="视图选项"></button></div><div data-row-key="session:s1"></div><div data-row-key="session:s2"></div></div></body>')
  const previous = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, HTMLElement: globalThis.HTMLElement }
  globalThis.document = dom.window.document
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.HTMLElement = dom.window.HTMLElement
  try {
    const listeners = new Set()
    const snapshot = { board: { cards: [{ sessionId: 's1' }] } }
    const client = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ snapshot }) }
    const stop = registerSidebarMembershipFilter(client, key => key)
    await new Promise(resolve => setTimeout(resolve, 0))
    const button = document.querySelector('[data-session-dashboard-filter]')
    assert.ok(button, 'the filter control sits beside the native view-options button')
    assert.equal(button.getAttribute('aria-pressed'), 'false')
    button.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(document.documentElement.dataset.sessionDashboardExclude, 'true')
    assert.equal(button.getAttribute('aria-pressed'), 'true')
    assert.equal(document.querySelector('[data-row-key="session:s1"]').getAttribute('data-session-dashboard-member'), 'true')
    assert.equal(document.querySelector('[data-row-key="session:s2"]').getAttribute('data-session-dashboard-member'), null)
    button.click()
    assert.equal(document.documentElement.dataset.sessionDashboardExclude, undefined)
    stop()
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document
    if (previous.MutationObserver === undefined) delete globalThis.MutationObserver; else globalThis.MutationObserver = previous.MutationObserver
    if (previous.HTMLElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = previous.HTMLElement
    dom.window.close()
  }
})
