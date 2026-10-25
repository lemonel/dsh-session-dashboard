import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { PREVIEW_RECONCILE_CHECKPOINTS_MS, PREVIEW_RECONCILE_MS, createPreviewReconciler } from '../lib/frontend/preview-reconcile.js'

const TARGET = 'target-session'
const OTHER = 'subagent-session'

function harness({ catalogue = [TARGET, OTHER], shown = null } = {}) {
  const state = { catalogue: [...catalogue], shown }
  const attempts = []
  const reconcile = createPreviewReconciler({
    shown: () => state.shown,
    open: sessionId => {
      attempts.push(sessionId)
      if (!state.catalogue.includes(sessionId)) return false
      state.shown = sessionId
      return true
    },
  })
  return { state, attempts, reconcile }
}

test('preview reconciliation constants describe a two-second startup window', () => {
  assert.equal(PREVIEW_RECONCILE_MS, 2_000)
  assert.deepEqual([...PREVIEW_RECONCILE_CHECKPOINTS_MS], [1_000, 2_000])
})

test('preview opens immediately, verifies once at 1s and once at 2s, then stops', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ shown: OTHER })
  reconcile.start(TARGET)
  assert.deepEqual(attempts, [TARGET], 'a cold frame reveals the target at once')

  t.mock.timers.tick(999)
  assert.deepEqual(attempts, [TARGET], 'nothing happens before the first checkpoint')

  state.shown = OTHER // a native boot restore lands after the first reveal
  t.mock.timers.tick(1)
  assert.deepEqual(attempts, [TARGET, TARGET], 'the 1s checkpoint corrects the restore once')

  state.shown = OTHER
  t.mock.timers.tick(1_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'the 2s checkpoint corrects once more')

  state.shown = OTHER
  t.mock.timers.tick(60_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'after 2s the frame stops correcting on its own')
  reconcile.dispose()
})

test('preview does not repeat an open while the target is already shown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { attempts, reconcile } = harness({ shown: null })
  reconcile.start(TARGET)
  assert.deepEqual(attempts, [TARGET])
  t.mock.timers.tick(2_000)
  assert.deepEqual(attempts, [TARGET], 'the checkpoints see the target and do nothing')
  t.mock.timers.tick(10_000)
  assert.deepEqual(attempts, [TARGET])
  reconcile.dispose()
})

test('a reader who follows a subagent at 1.5s is corrected once at 2s and then left alone', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ shown: null })
  reconcile.start(TARGET)
  t.mock.timers.tick(1_500)
  assert.deepEqual(attempts, [TARGET], 'the 1s checkpoint found the target and kept it')

  state.shown = OTHER // the reader clicks a subagent inside the preview
  t.mock.timers.tick(500)
  assert.deepEqual(attempts, [TARGET, TARGET], 'the final 2s checkpoint returns to the requested Session')

  state.shown = OTHER // the reader follows the subagent again after the window
  t.mock.timers.tick(10_000)
  assert.deepEqual(attempts, [TARGET, TARGET], 'the frame never pulls the target back after the last check')
  reconcile.dispose()
})

test('catalogue arrival only finishes a first open that never succeeded', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ catalogue: [OTHER], shown: OTHER })
  reconcile.start(TARGET)
  assert.deepEqual(attempts, [TARGET], 'the initial open cannot find an uncatalogued target')
  assert.equal(state.shown, OTHER)

  t.mock.timers.tick(1_000)
  assert.deepEqual(attempts, [TARGET, TARGET], 'the 1s checkpoint retries the waiting first open')

  state.catalogue.push(TARGET)
  reconcile.catalogueChanged()
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'the catalogue event completes the first open once')
  assert.equal(state.shown, TARGET)

  t.mock.timers.tick(1_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'the 2s checkpoint sees the target and does not repeat')
  state.shown = OTHER
  reconcile.catalogueChanged()
  t.mock.timers.tick(60_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'a later catalogue event never re-pulls an opened target')
  reconcile.dispose()
})

test('a catalogue that arrives after the 2s window is not chased', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ catalogue: [OTHER], shown: OTHER })
  reconcile.start(TARGET)
  t.mock.timers.tick(2_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'both checkpoints retried the missing target')

  state.catalogue.push(TARGET)
  reconcile.catalogueChanged()
  t.mock.timers.tick(10_000)
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'the startup wait ends at 2s')
  reconcile.dispose()
})

test('a new preview target restarts the 1s/2s schedule', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ catalogue: [TARGET, OTHER], shown: null })
  reconcile.start(TARGET)
  t.mock.timers.tick(1_200)
  assert.deepEqual(attempts, [TARGET])

  reconcile.start(OTHER)
  assert.deepEqual(attempts, [TARGET, OTHER], 'the switch opens its own target at once')
  t.mock.timers.tick(999)
  assert.deepEqual(attempts, [TARGET, OTHER])

  state.shown = TARGET
  t.mock.timers.tick(1)
  assert.deepEqual(attempts, [TARGET, OTHER, OTHER], 'the new target gets its own 1s checkpoint')
  state.shown = TARGET
  t.mock.timers.tick(1_000)
  assert.deepEqual(attempts, [TARGET, OTHER, OTHER, OTHER], 'and its own 2s checkpoint')
  state.shown = TARGET
  t.mock.timers.tick(10_000)
  assert.deepEqual(attempts, [TARGET, OTHER, OTHER, OTHER], 'then the restarted window also ends')
  reconcile.dispose()
})

test('an explicit parent request navigates without restarting the startup checks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ shown: null })
  reconcile.start(TARGET)
  t.mock.timers.tick(2_000)
  assert.deepEqual(attempts, [TARGET])

  state.shown = OTHER
  reconcile.requestOpen()
  assert.deepEqual(attempts, [TARGET, TARGET], 'an explicit request still honors the parent target after the window')
  t.mock.timers.tick(5_000)
  assert.deepEqual(attempts, [TARGET, TARGET], 'the request does not reopen the automatic window')

  state.shown = OTHER
  reconcile.requestOpen()
  assert.deepEqual(attempts, [TARGET, TARGET, TARGET], 'each explicit request navigates while the reader sits elsewhere')
  reconcile.dispose()
})

test('a synchronous catalogue event during open cannot recurse into a second open', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { shown: null }
  let reconcile
  const attempts = []
  reconcile = createPreviewReconciler({
    shown: () => state.shown,
    open: sessionId => {
      attempts.push(sessionId)
      state.shown = sessionId
      reconcile.catalogueChanged() // DSH republishes retention synchronously
      return true
    },
  })
  reconcile.start(TARGET)
  assert.deepEqual(attempts, [TARGET])
  t.mock.timers.tick(2_000)
  assert.deepEqual(attempts, [TARGET])
  reconcile.dispose()
})

test('dispose cancels every pending checkpoint', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { state, attempts, reconcile } = harness({ shown: null })
  reconcile.start(TARGET)
  t.mock.timers.tick(500)
  reconcile.dispose()
  state.shown = OTHER
  t.mock.timers.tick(10_000)
  assert.deepEqual(attempts, [TARGET], 'a disposed frame keeps whatever it shows')
})

/* The compiled client is the code the browser actually loads. This wires the
 * preview branch against a jsdom document and a fake native catalogue so the
 * 1s/2s window, the catalogue subscription rule and the explicit parent request
 * are exercised end to end rather than only through the helper. */
function fakeTimers() {
  let now = 0
  let sequence = 0
  const tasks = new Map()
  return {
    setTimeout(callback, delay = 0) {
      const id = ++sequence
      tasks.set(id, { at: now + Number(delay), callback })
      return id
    },
    clearTimeout(id) { tasks.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let next
        for (const entry of tasks) {
          if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry
        }
        if (next === undefined) break
        tasks.delete(next[0])
        now = next[1].at
        next[1].callback()
      }
      now = end
    },
    pending: () => tasks.size,
  }
}

async function loadPreviewClient(timers) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-slot="root"><div style="grid-template-columns: 280px minmax(0px, 1fr) minmax(0px, 0px);"></div></div></body></html>', {
    url: `http://localhost/?session-dashboard-preview=${TARGET}`,
    pretendToBeVisual: true,
  })
  let exported
  const require = createRequire(import.meta.url)
  dom.window.__ModuleLoader__ = {
    load(entry) {
      assert.equal(entry.id, '@hsx/dsh-session-dashboard')
      exported = entry.factory(id => {
        assert.ok(id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom', id)
        return require(id)
      })
    },
  }
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, {
    window: dom.window, document: dom.window.document, console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    crypto: globalThis.crypto, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, TextEncoder, URL: dom.window.URL,
    AbortController, performance: globalThis.performance, structuredClone, navigator: dom.window.navigator,
  }, { filename: 'lib/client.js' })
  assert.equal(typeof exported.apply, 'function')

  const catalogue = { ids: [TARGET, OTHER], shown: null }
  const listeners = new Set()
  const opens = []
  const panels = []
  const cleanups = []
  const publish = () => { for (const listener of [...listeners]) listener() }
  const snapshot = () => ({
    ids: [...catalogue.ids],
    byId: Object.fromEntries(catalogue.ids.map(id => [id, { retainedBy: { mainView: catalogue.shown === id ? 1 : 0 } }])),
  })
  const sessions = { list: { getSnapshot: snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } } }
  const uiWorkspace = {
    openSession(id) {
      opens.push(id)
      if (!catalogue.ids.includes(id)) throw new Error('uncatalogued Session')
      catalogue.shown = id
      publish()
    },
  }
  const layout = { selectPanel(id) { panels.push(id) } }
  const child = {
    effect(run) { const cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup); return () => {} },
    get(name) { return { sessions, layout }[name] },
    uiWorkspace,
  }
  let previewFiber
  const ctx = {
    inject(keys, callback) {
      assert.equal(keys.join(','), 'uiWorkspace,layout,sessions')
      callback(child)
      previewFiber = { async dispose() { for (const cleanup of cleanups.splice(0)) cleanup() } }
      return previewFiber
    },
  }
  const close = await exported.apply(ctx)
  return {
    dom, close, opens, panels, catalogue,
    switchTo(id) { catalogue.shown = id; publish() },
    previewFiber,
  }
}

test('the compiled preview branch checks at 1s and 2s only and leaves subagent navigation alone', async t => {
  const timers = fakeTimers()
  const app = await loadPreviewClient(timers)
  assert.deepEqual(app.opens, [TARGET], 'the frame opens the URL target at once')
  assert.deepEqual(app.panels, [null], 'the native conversation replaces a restored dashboard panel')
  assert.equal(app.dom.window.document.querySelector('[data-session-dashboard-preview-frame]') !== null, true)
  // Hiding the leading navigation column must not freeze the native template:
  // the frame rewrites only its first track, so the right Sidebar keeps the width
  // the native layout gives it and the frame's own toggle still works.
  const previewStyle = [...app.dom.window.document.querySelectorAll('style')].find(style => (style.textContent ?? '').includes('data-session-dashboard-preview-frame'))
  assert.ok(previewStyle, 'the preview frame injects its layout style')
  assert.doesNotMatch(previewStyle.textContent, /grid-template-columns/, 'the stylesheet leaves the native template alone')
  assert.match(previewStyle.textContent, /\[class\*="sidebarCol"\]/)
  // Only the leading navigation handle is hidden: the right Sidebar keeps its own
  // grabber, so its width stays adjustable inside a preview.
  assert.match(previewStyle.textContent, /\[class\*="handle"\]\[data-side="sidebar"\]/, 'the leading handle is the only one hidden')
  assert.doesNotMatch(previewStyle.textContent, /> \[class\*="handle"\] \{/, 'the right Sidebar handle is not blanket-hidden')
  const frameGrid = app.dom.window.document.querySelector('[data-session-dashboard-preview-frame]').getAttribute('style')
  assert.match(frameGrid, /grid-template-columns:\s*0px minmax\(0px, 1fr\) minmax\(0px, 0px\)/, 'only the leading track collapses')
  // The native layout rewrites the whole template when the right Sidebar opens;
  // the frame must fold the leading track again and keep the opened trailing one.
  const frame = app.dom.window.document.querySelector('[data-session-dashboard-preview-frame]')
  frame.setAttribute('style', 'grid-template-columns: 280px minmax(400px, 1fr) minmax(0px, 720px);')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.match(frame.getAttribute('style'), /grid-template-columns:\s*0px minmax\(400px, 1fr\) minmax\(0px, 720px\)/, 'the opened right Sidebar track survives')

  timers.advance(999)
  assert.deepEqual(app.opens, [TARGET])

  app.switchTo(OTHER) // the reader clicks a subagent after the 1s checkpoint
  timers.advance(1)
  assert.deepEqual(app.opens, [TARGET, TARGET], 'the 1s checkpoint returns to the target once')

  app.switchTo(OTHER)
  timers.advance(1_000)
  assert.deepEqual(app.opens, [TARGET, TARGET, TARGET], 'the 2s checkpoint corrects once more')

  app.switchTo(OTHER)
  timers.advance(60_000)
  assert.deepEqual(app.opens, [TARGET, TARGET, TARGET], 'the compiled path has no continuous target pull')
  assert.equal(timers.pending(), 0, 'no timer survives the two-second window')

  // An explicit parent navigation request is not the automatic guard: it still
  // works after the window, but does not recreate the 1s/2s schedule.
  app.dom.window.dispatchEvent(new app.dom.window.MessageEvent('message', {
    data: { type: 'session-dashboard-preview-open', sessionId: TARGET },
    origin: app.dom.window.location.origin,
  }))
  assert.deepEqual(app.opens, [TARGET, TARGET, TARGET, TARGET])
  app.switchTo(OTHER)
  timers.advance(10_000)
  assert.deepEqual(app.opens, [TARGET, TARGET, TARGET, TARGET])
  assert.equal(timers.pending(), 0)

  await app.close()
  app.switchTo(OTHER)
  timers.advance(10_000)
  assert.deepEqual(app.opens, [TARGET, TARGET, TARGET, TARGET], 'cleanup removes the timer and the catalogue subscription')
})

test('the compiled preview branch resets its checkpoints for a new target', async t => {
  const timers = fakeTimers()
  const app = await loadPreviewClient(timers)
  timers.advance(1_200)
  assert.deepEqual(app.opens, [TARGET])

  app.dom.window.dispatchEvent(new app.dom.window.MessageEvent('message', {
    data: { type: 'session-dashboard-preview-open', sessionId: OTHER },
    origin: app.dom.window.location.origin,
  }))
  assert.deepEqual(app.opens, [TARGET, OTHER], 'a new target opens immediately')

  timers.advance(999)
  assert.deepEqual(app.opens, [TARGET, OTHER])
  app.switchTo(TARGET)
  timers.advance(1)
  assert.deepEqual(app.opens, [TARGET, OTHER, OTHER], 'the new target gets its own 1s check')
  app.switchTo(TARGET)
  timers.advance(1_000)
  assert.deepEqual(app.opens, [TARGET, OTHER, OTHER, OTHER], 'and its own 2s check')
  app.switchTo(TARGET)
  timers.advance(10_000)
  assert.deepEqual(app.opens, [TARGET, OTHER, OTHER, OTHER])
  await app.close()
})
