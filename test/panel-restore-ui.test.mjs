import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { PANEL_PREFERENCE_KEY, isTopLevelWindow, restorePanelOnBoot, watchPanelPreference } from '../lib/frontend/panel-restore.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent })) Object.defineProperty(globalThis, key, { configurable: true, value })
const PANEL = 'session-dashboard'
const disposers = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); try { dom.window.localStorage.clear() } catch {} })
const keep = dispose => { disposers.push(dispose); return dispose }
const preference = () => { try { return dom.window.localStorage.getItem(PANEL_PREFERENCE_KEY) } catch { return null } }

/** A tiny stand-in for ctx.layout: one active panel, synchronous subscribers, and a
 *  registration flag so selectPanel can fail exactly like the host does before the
 *  main key is registered. */
function layoutFixture({ initial = null, registered = true } = {}) {
  let active = initial, isRegistered = registered
  const listeners = new Set()
  const notify = () => { for (const fn of [...listeners]) fn() }
  return {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: active }),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    selectPanel(id) {
      if (id !== null && id !== PANEL) throw new Error(`main panel ${String(id)} is not registered`)
      if (id !== null && !isRegistered) throw new Error(`main panel ${String(id)} is not registered`)
      if (active === id) return
      active = id; notify()
    },
    set(value) { active = value; notify() },
    register() { isRegistered = true },
    get active() { return active },
    get subscribers() { return listeners.size },
  }
}

test('the watcher stores the dashboard choice and clears every other selection', () => {
  const layout = layoutFixture()
  keep(watchPanelPreference(layout, PANEL))
  layout.set(PANEL)
  assert.equal(preference(), PANEL)
  layout.set(null)
  assert.equal(preference(), null, 'a native conversation clears the remembered panel')
  layout.set(PANEL)
  assert.equal(preference(), PANEL)
  layout.set('other-panel')
  assert.equal(preference(), null, 'another plugin panel is not the dashboard choice')
})

test('a remembered dashboard panel is selected on boot', () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const layout = layoutFixture({ initial: null })
  keep(restorePanelOnBoot(layout, PANEL, { windowMs: 200, intervalMs: 10 }))
  assert.equal(layout.active, PANEL)
})

test('a native session restored after boot is corrected back to the remembered dashboard', () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const layout = layoutFixture({ initial: null })
  keep(restorePanelOnBoot(layout, PANEL, { windowMs: 200, intervalMs: 10 }))
  assert.equal(layout.active, PANEL)
  layout.set(null)
  assert.equal(layout.active, PANEL, 'the late native restore is overridden inside the boot window')
})

test('the panel is retried when the main key was not registered yet', async () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const layout = layoutFixture({ initial: null, registered: false })
  keep(restorePanelOnBoot(layout, PANEL, { windowMs: 300, intervalMs: 10 }))
  assert.equal(layout.active, null, 'an unregistered key cannot be selected yet')
  layout.register()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(layout.active, PANEL, 'the retry loop applies it once the key exists')
})

test('a user pointerdown or keydown abandons the restore immediately', () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const layout = layoutFixture({ initial: null })
  keep(restorePanelOnBoot(layout, PANEL, { windowMs: 200, intervalMs: 10 }))
  dom.window.dispatchEvent(new dom.window.Event('pointerdown'))
  layout.set(null)
  assert.equal(layout.active, null, 'an interaction wins over the remembered panel')
  const second = layoutFixture({ initial: null })
  keep(restorePanelOnBoot(second, PANEL, { windowMs: 200, intervalMs: 10 }))
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown' }))
  second.set(null)
  assert.equal(second.active, null)
})

test('without a preference the panel is never touched', () => {
  const layout = layoutFixture({ initial: null })
  let selects = 0
  const select = layout.selectPanel.bind(layout)
  layout.selectPanel = id => { selects += 1; select(id) }
  keep(restorePanelOnBoot(layout, PANEL, { windowMs: 200, intervalMs: 10 }))
  const watcher = layoutFixture({ initial: null })
  keep(watchPanelPreference(watcher, PANEL))
  assert.equal(layout.active, null)
  assert.equal(selects, 0)
  assert.equal(watcher.subscribers, 1, 'the preference watcher itself stays installed')
})

test('disposing the restore stops retries, corrections and listeners', () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const layout = layoutFixture({ initial: null })
  const dispose = restorePanelOnBoot(layout, PANEL, { windowMs: 200, intervalMs: 10 })
  assert.equal(layout.active, PANEL)
  dispose()
  layout.set(null)
  assert.equal(layout.active, null)
})

test('a blocked or throwing localStorage stays silent and never crashes', () => {
  const descriptor = Object.getOwnPropertyDescriptor(dom.window, 'localStorage')
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked by policy') } })
  try {
    assert.doesNotThrow(() => {
      const layout = layoutFixture({ initial: null })
      keep(watchPanelPreference(layout, PANEL))
      keep(restorePanelOnBoot(layout, PANEL, { windowMs: 50, intervalMs: 10 }))
      layout.set(PANEL)
      layout.set(null)
    })
  } finally {
    if (descriptor) Object.defineProperty(dom.window, 'localStorage', descriptor)
  }
})

/** A frame loads the same DSH page; it must never claim the panel or touch storage. */
function frameWindow(overrides = {}) {
  const calls = { get: 0, set: 0, remove: 0 }
  const storage = {
    getItem() { calls.get += 1; return PANEL },
    setItem() { calls.set += 1 },
    removeItem() { calls.remove += 1 },
  }
  const frame = { top: {}, self: {}, localStorage: storage, addEventListener() {}, removeEventListener() {}, ...overrides }
  return { frame, calls }
}

test('a top-level window is detected; a frame or cross-origin top is not', () => {
  assert.equal(isTopLevelWindow(dom.window), true)
  assert.equal(isTopLevelWindow(frameWindow().frame), false)
  const crossOrigin = { self: {}, get top() { throw new Error('blocked a cross-origin frame') }, localStorage: { getItem() { throw new Error('no storage') } } }
  assert.equal(isTopLevelWindow(crossOrigin), false)
  assert.equal(isTopLevelWindow(null), false)
})

test('inside an iframe the restore never selects the panel nor touches localStorage', () => {
  dom.window.localStorage.setItem(PANEL_PREFERENCE_KEY, PANEL)
  const { frame, calls } = frameWindow()
  const restoreLayout = layoutFixture({ initial: null })
  keep(restorePanelOnBoot(restoreLayout, PANEL, { window: frame, windowMs: 200, intervalMs: 10 }))
  assert.equal(restoreLayout.active, null, 'the frame keeps whatever the host is showing')
  assert.equal(restoreLayout.subscribers, 0)
  const watchLayout = layoutFixture({ initial: null })
  keep(watchPanelPreference(watchLayout, PANEL, { window: frame }))
  watchLayout.set(PANEL)
  assert.equal(watchLayout.subscribers, 0, 'the frame does not even subscribe')
  assert.deepEqual(calls, { get: 0, set: 0, remove: 0 }, 'a frame never reads or writes the preference')
  assert.equal(dom.window.localStorage.getItem(PANEL_PREFERENCE_KEY), PANEL, 'the top-level preference is untouched')
})

test('a cross-origin top access is treated as a frame and stays silent', () => {
  const reads = { count: 0 }
  const crossOrigin = { self: {}, get top() { throw new Error('blocked a cross-origin frame') }, localStorage: { getItem() { reads.count += 1; return PANEL }, setItem() {}, removeItem() {} }, addEventListener() {}, removeEventListener() {} }
  const layout = layoutFixture({ initial: null })
  assert.doesNotThrow(() => keep(restorePanelOnBoot(layout, PANEL, { window: crossOrigin, windowMs: 50, intervalMs: 10 })))
  assert.equal(layout.active, null)
  assert.equal(reads.count, 0)
})
