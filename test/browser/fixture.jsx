/* Isolated native-slot fixture, not the live DSH shell. Transport,
 * uiWorkspace navigation, absent session scope and peer shell are fixture-owned.
 * LocaleRuntime is real; the unrelated locale settings plugin is not applied. */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JSXRuntime from 'react/jsx-runtime'
import * as Cordis from '@deepseek-ai/cordis'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotProbe } from './slot-contribution.tsx'
// Native locale's factory requires these peers but its exported dictionary
// runtime never touches them. Fail loudly rather than simulate any settings UI
// or pull the unrelated full markdown/shiki/katex atom dependency tree.
const unusedLocalePeer = name => new Proxy(Object.create(null), {
  get(_target, property) { throw new Error(`Out-of-scope locale settings peer used: ${name}.${String(property)}`) },
})

const modules = new Map(Object.entries({
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-client-ui-slots': Slots,
  '@deepseek-ai/dsh-client-store': unusedLocalePeer('store'),
  '@deepseek-ai/dsh-client-ui-primitives': unusedLocalePeer('primitives'),
}))
const loadedIds = []
window.__ModuleLoader__ = {
  load({ id, factory }) {
    if (modules.has(id)) throw new Error(`Duplicate fixture module: ${id}`)
    const value = factory(name => {
      if (!modules.has(name)) throw new Error(`Unregistered native peer: ${name}`)
      return modules.get(name)
    })
    modules.set(id, value)
    loadedIds.push(id)
  },
}

const ctx = new Cordis.Context()
const fibers = []
const openSessionCalls = []
// Every navigation the floating preview posts into this document. The fixture
// page is what the preview iframe loads, so this records the real protocol.
const previewNavigations = []
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return
  const data = event.data
  if (!data || data.type !== 'session-dashboard-preview-open' || typeof data.sessionId !== 'string') return
  previewNavigations.push(data.sessionId)
  // Stand in for the native conversation body, which stamps the Session it
  // renders. The floating window only reveals a frame that confirms this id.
  document.documentElement.setAttribute('data-conversation-session', data.sessionId)
})
const mountStats = { mounted: 0, unmounted: 0 }
// A preview's enter link opens session-dashboard-open in a new browser tab. That
// tab is the complete native client, so model the host services the plugin reads
// there. Every other fixture page deliberately omits layout and the session
// catalogue, keeping the plugin's own preview and fallback branches observable.
const openDestination = (() => {
  const value = new URL(window.location.href).searchParams.get('session-dashboard-open')
  return value !== null && value !== '' ? value : null
})()
const panelSelections = []
const panelListeners = new Set()
let activePanelId = null
const publishPanel = () => { for (const listener of [...panelListeners]) listener() }
const sessionCatalog = { ids: [], shown: null, listeners: new Set() }
const publishCatalog = () => { for (const listener of [...sessionCatalog.listeners]) listener() }
const catalogSnapshot = () => ({
  ids: sessionCatalog.ids,
  byId: Object.fromEntries(sessionCatalog.ids.map(id => [id, { retainedBy: { mainView: sessionCatalog.shown === id ? 1 : 0 } }])),
})
// Fixture-owned late boot restore: the native client may finish its own restore
// after the plugin applied, which the catalogue subscription has to correct. The
// native restore also selects the conversation panel, like the real layout does.
const bootRestore = sessionId => {
  sessionCatalog.shown = sessionId
  publishCatalog()
  if (openDestination !== null && activePanelId !== 'fixture-session') { activePanelId = 'fixture-session'; publishPanel() }
}
if (openDestination !== null) {
  // The native client boots with its own catalogue. Tests seed the ids this page
  // should report, and they appear a moment later like a real cold boot.
  setTimeout(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('fixture:session-ids') ?? '[]')
      if (Array.isArray(stored)) sessionCatalog.ids = stored.filter(id => typeof id === 'string')
    } catch { /* no catalogue was seeded */ }
    publishCatalog()
  }, 250)
}
let dashboardFiber
let selectPanel
let unmountApp
const failures = []
ctx.on('internal/error', error => { failures.push(String(error)); console.error(error) })
const mount = async plugin => {
  const fiber = ctx.plugin(plugin)
  fibers.push(fiber)
  await fiber.await()
  return fiber
}

await import('/native/renderer.js')
await import('/native/locale.js')
await import('/native/dashboard.js')
const renderer = modules.get('@deepseek-ai/dsh-client-ui-renderer')
const { LocaleRuntime } = modules.get('@deepseek-ai/dsh-client-locale')
const dashboard = modules.get('@hsx/dsh-session-dashboard')
await mount(renderer)
const locale = new LocaleRuntime(ctx, undefined, { languages: ['zh-CN'], preference: 'zh' })
ctx.reflect.provide('locale', locale)
ctx.slots.installLocale(locale)
// The real renderer always installs an optional-session provider, even for a
// root-only page. This fixture explicitly has no selected or executable session.
const absentSession = Object.freeze({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
const absentSource = { getSnapshot: () => absentSession, subscribe: () => () => {} }
ctx.slots.installScope('session', { current: absentSource, bindingSource: () => absentSource })

const api = {
  handshake: () => window.dashboardRpc('handshake', {}),
  extensionSnapshot: query => window.dashboardRpc('extensionSnapshot', { query }),
  navigation: query => window.dashboardRpc('navigation', { query }),
  snapshot: () => window.dashboardRpc('snapshot', {}),
  candidates: query => window.dashboardRpc('candidates', { query }),
  inspectSession: query => window.dashboardRpc('inspectSession', { query }),
  history: query => window.dashboardRpc('history', { query }),
  transcript: query => window.dashboardRpc('transcript', { query }),
  mutate: mutation => window.dashboardRpc('mutate', { mutation }),
}
const remote = {
  async $mount(contract) {
    if (contract.package !== '@hsx/dsh-session-dashboard' || contract.descriptors.length !== 10) throw new Error('Wrong dashboard RPC contribution')
    mountStats.mounted++
    remote.sessionDashboard = api
    const unregister = ctx.reflect.provide('remote.sessionDashboard', api)
    return async () => {
      unregister()
      delete remote.sessionDashboard
      mountStats.unmounted++
    }
  },
}
ctx.reflect.provide('remote', remote)
ctx.reflect.provide('uiWorkspace', {
  openSession(id) {
    openSessionCalls.push(id)
    // Model the native retention the plugin observes: the opened Session becomes
    // the one this tab renders, and both the catalogue and the panel projection
    // republish that fact. The panel watcher is therefore observable too.
    if (openDestination !== null) {
      sessionCatalog.shown = id
      publishCatalog()
      if (activePanelId !== 'fixture-session') { activePanelId = 'fixture-session'; publishPanel() }
    }
    selectPanel('fixture-session')
  },
})
if (openDestination !== null) ctx.reflect.provide('layout', {
  panelInfo: {
    getSnapshot: () => ({ activePanelId }),
    subscribe(listener) { panelListeners.add(listener); return () => { panelListeners.delete(listener) } },
  },
  selectPanel(id) {
    panelSelections.push(id)
    // The real host republishes its panel projection after a real selection only;
    // the plugin's preference watcher observes that change, so expose the same fact.
    const next = id ?? null
    if (activePanelId !== next) { activePanelId = next; publishPanel() }
    selectPanel?.(id ?? 'fixture-session')
  },
})
// The Workspace Controller projection the picker reads; tests replace the rows
// through window.dashboardFixture before clicking New session.
ctx.reflect.provide('workspaces', {
  list: { getSnapshot: () => ({ items: window.dashboardFixture?.workspaces ?? [] }) },
})
// The browser face's Client Session Controller, reduced to the create operation
// the dashboard needs. Tests preallocate the id of the Host Session they seeded.
ctx.reflect.provide('sessions', {
  ...(openDestination === null ? {} : {
    list: {
      getSnapshot: catalogSnapshot,
      subscribe(listener) { sessionCatalog.listeners.add(listener); return () => { sessionCatalog.listeners.delete(listener) } },
    },
  }),
  async create(options) {
    window.dashboardFixture.createdWith = structuredClone(options)
    const id = window.dashboardFixture?.createSessionId
    if (typeof id !== 'string' || id.length === 0) throw new Error('fixture: no session creation target')
    return id
  },
  async using(sessionId, options, run) {
    return run({ binding: { session: { async prompt(content, mode) {
      window.dashboardFixture.prompted = { sessionId, source: options.source, content: structuredClone(content), mode }
      return window.dashboardFixture.promptResult ?? { ok: true, value: { accepted: true } }
    } } } })
  },
})

function FixtureShell({ renderSlot }) {
  const [selected, setSelected] = React.useState('plugins')
  selectPanel = setSelected
  React.useSyncExternalStore(
    listener => ctx.slots.subscribe('sidebar.panellist', listener),
    () => ctx.slots.getVersion('sidebar.panellist'),
  )
  return <div className="fixture-shell" data-fixture-scope="real-slot-registry-fixture-shell">
    <aside aria-label="Fixture host navigation">
      <p className="fixture-scope">Isolated native-slot fixture</p>
      {ctx.slots.entriesOfSlot('sidebar.panellist').map(entry => <button key={entry.options.id}
        data-fixture-nav={entry.options.id} aria-pressed={selected === entry.options.id}
        onClick={() => setSelected(entry.options.id)}>
        {renderSlot('sidebar.panellist', { size: 19 }, { only: entry.options.id })}
        <span>{Slots.resolveSlotLabel(entry.options.label)}</span>
      </button>)}
    </aside>
    <main>{renderSlot('main', {}, { entryKey: selected })}</main>{renderSlot('shell.overlay', {})}
  </div>
}
await mount({
  name: 'dashboard-browser-fixture-shell',
  inject: ['slots'],
  apply(child) {
    child.slots.register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } }, FixtureShell)
    child.slots.register({ name: 'main', key: 'plugins' }, () => <section className="fixture-peer"><h1>Fixture Plugins</h1><p>This is peer navigation, not the installed DSH shell.</p></section>)
    child.slots.register({ name: 'sidebar.panellist', id: 'plugins', order: 3, label: '插件' }, () => <span aria-hidden="true">◇</span>)
    child.slots.register({ name: 'main', key: 'fixture-session' }, () => <section className="fixture-peer"><h1>Fixture session navigation</h1><p>No user session is opened or executed.</p><button onClick={() => selectPanel('session-dashboard')}>返回仪表板</button></section>)
  },
})
dashboardFiber = await mount(dashboard)
const slotProbe = createSlotProbe(ctx)
unmountApp = ctx.uiRenderer.mount(document.getElementById('app'))

window.dashboardFixture = {
  loadedIds,
  failures,
  mountStats,
  openSessionCalls,
  previewNavigations,
  panelSelections,
  bootRestore,
  slotProbe,
  workspaces: [],
  createSessionId: null,
  createdWith: null,
  prompted: null,
  promptResult: null,
  setLocale: value => locale.setLocale(value),
  slots() {
    return {
      root: ctx.slots.entries('root').length,
      main: ctx.slots.entries('main').map(entry => ({ key: entry.options.key, locale: entry.locale ?? null })),
      sidebar: ctx.slots.entries('sidebar.panellist').map(entry => ({ id: entry.options.id, order: entry.options.order, label: Slots.resolveSlotLabel(entry.options.label), locale: entry.locale ?? null })),
      nativeRegistry: ctx.slots instanceof renderer.SlotRegistry,
    }
  },
  async unloadDashboard() { await dashboardFiber.dispose() },
  async reloadDashboard() { dashboardFiber = await mount(dashboard) },
  async dispose() {
    await slotProbe.dispose()
    unmountApp()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  },
}
window.dispatchEvent(new Event('dashboard-fixture-ready'))
