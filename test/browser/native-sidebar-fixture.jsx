/* Real, intact DSH web baseline + renderer + WorkspaceBrowser/SessionNodeItem.
 * Only controller data, commands, and membership callback are fixture-owned.
 * No private host DOM listener, rewritten source, copied row, or global drag hook. */
const boot = window.nativeSidebarBoot
let finishBaseline
const baseline = new Promise(resolve => { finishBaseline = resolve })
window.__ModuleLoader__ = {
  create({ staticModules }) {
    finishBaseline(staticModules)
    // The real shell's normal boot may finish, but this fixture owns assembly.
    return {
      manifest: { plugins: [] }, prefetch: async () => {}, importError: () => undefined,
      entries: { start: async () => {} },
    }
  },
}
await import(boot.shellEntry)
const hostModules = await baseline
const modules = new Map(Object.entries(hostModules))
const loaded = []
window.__ModuleLoader__.load = ({ id, factory }) => {
  if (modules.has(id)) throw new Error(`Duplicate intact factory ${id}`)
  modules.set(id, factory(name => {
    if (!modules.has(name)) throw new Error(`Native SDK peer missing from selected baseline: ${name}`)
    return modules.get(name)
  }))
  loaded.push(id)
}
const React = modules.get('react')
const { Context } = modules.get('@deepseek-ai/cordis')
const { createSnapshotStore } = modules.get('@deepseek-ai/dsh-client-store')
await import('/native/renderer.js')
await import('/native/locale.js')
await import('/native/workspace.js')
await import('/native/sidebar.js')
const renderer = modules.get('@deepseek-ai/dsh-client-ui-renderer')
const { LocaleRuntime } = modules.get('@deepseek-ai/dsh-client-locale')
const workspace = modules.get('@deepseek-ai/dsh-client-ui-workspace')
const sidebar = modules.get('session-dashboard/native-sidebar-test')
const ctx = new Context()
const fibers = []
const failures = []
ctx.on('internal/error', error => { failures.push(String(error)); console.error(error) })
const mount = async plugin => {
  const fiber = ctx.plugin(plugin)
  fibers.push(fiber)
  await fiber.await()
  if (fiber.error) throw fiber.error
  // Cordis' public const enum FiberState.ACTIVE is the numeric value 2;
  // const enums have no runtime export in the selected web staticModules.
  if (fiber.state !== 2) throw new Error(`Native fixture plugin did not activate: ${Object.keys(fiber.inject ?? {}).filter(key => ctx.get(key) === undefined).join(', ')}`)
  return fiber
}
const view = {
  groupBy: boot.groupBy, orderBy: boot.orderBy,
  groupExpansion: { 'fixture-workspace': true },
  sessionOrderByAccount: boot.orderBy === 'manual' ? { 'fixture-workspace': ['native-a', 'native-b', 'native-c'], __flat_session_order__: ['native-a', 'native-b', 'native-c'] } : {},
  archivedFilter: 'default',
}
localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(view))
const summaries = Object.fromEntries(['native-a', 'native-b', 'native-c'].map((id, index) => [id, {
  id, title: ['原生会话 Alpha', '原生会话 Bravo', '原生会话 Charlie'][index],
  blank: false, running: false, cwd: '/fixture/workspace', updatedAt: 1735689603000 - index * 1000,
  retainedBy: {},
}]))
const sessionsList = createSnapshotStore({ phase: 'loading', state: 'loading', ids: Object.keys(summaries), byId: summaries, projectionsBySession: {} })
const workspaceList = createSnapshotStore({ phase: 'loading', state: 'loading', items: [], pinnedSessionIds: [], archivedSessionIds: [] })
const statuses = createSnapshotStore(new Map())
const panels = createSnapshotStore({ activePanelId: 'fixture-membership', activeSessionId: undefined })
const calls = { retained: [], created: [], selected: [], execution: [], workspaceMutation: [], joined: [], drops: [], dragLifecycle: [] }
ctx.reflect.provide('sessions', {
  list: sessionsList, searchResultLimit: 100,
  retain(target, options) { calls.retained.push({ target, options }); return { sessionId: typeof target === 'string' ? target : target.sessionId, release() {} } },
  subagentAddress() { return undefined },
  async create(input) { calls.created.push(input); throw new Error('No fixture session creation is authorized') },
  async search() { return { ok: true, value: { items: [], hasMore: false } } },
  async fork(input) { calls.created.push(input); throw new Error('No fixture fork is authorized') },
})
ctx.reflect.provide('workspaces', {
  list: workspaceList,
  async initializeDefault() { return undefined },
  async rename(...args) { calls.workspaceMutation.push(['rename', ...args]) },
  async delete(...args) { calls.workspaceMutation.push(['delete', ...args]) },
  async insertBefore(...args) { calls.workspaceMutation.push(['insertBefore', ...args]) },
  async create(...args) { calls.workspaceMutation.push(['create', ...args]) },
  async archiveSession(...args) { calls.workspaceMutation.push(['archiveSession', ...args]) },
  async unarchiveSession(...args) { calls.workspaceMutation.push(['unarchiveSession', ...args]) },
  async pinSession(...args) { calls.workspaceMutation.push(['pinSession', ...args]) },
  async unpinSession(...args) { calls.workspaceMutation.push(['unpinSession', ...args]) },
})
ctx.reflect.provide('layout', {
  panelInfo: panels,
  beginNavigation() { return new AbortController().signal },
  selectPanel(id) { calls.selected.push(id); panels.set({ ...panels.getSnapshot(), activePanelId: id }) },
})
const shortcuts = createSnapshotStore([])
ctx.reflect.provide('shortcuts', { catalog: shortcuts, register() { return () => {} } })
const productionApi = Object.fromEntries(['handshake', 'snapshot', 'candidates', 'inspectSession', 'history', 'mutate', 'navigation', 'summary', 'extensionAction'].map(method => [method, (...args) => window.dashboardRpc(method, Object.fromEntries(([{ candidates: ['query'], inspectSession: ['query'], history: ['query'], mutate: ['mutation'], navigation: ['query'], summary: ['query'], extensionAction: ['request'] }[method] ?? []]).map((name, index) => [name, args[index]])))]))
const remote = {
  $host: { home: '/fixture', platform: 'linux' }, directoryPicker: {},
  async $mount(contract) {
    if (!boot.integration || contract.descriptors.length !== 10) throw new Error('Wrong production dashboard API2 contribution')
    remote.sessionDashboard = productionApi
    const unregister = ctx.reflect.provide('remote.sessionDashboard', productionApi)
    return async () => { unregister(); delete remote.sessionDashboard }
  },
}
ctx.reflect.provide('remote', remote)
ctx.reflect.provide('remote.directoryPicker', remote.directoryPicker)
// ui-workspace >= 0.2.1-alpha.3 requires the public ClientRemoteAccess
// controller. Its source(kind,id,action) contract is HostObservable<boolean>.
// This fixture explicitly represents an authorized owner, not a live account.
const ownerAccess = createSnapshotStore(true)
ctx.reflect.provide('remoteAccess', { source() { return ownerAccess } })
await mount(renderer)
const locale = new LocaleRuntime(ctx, undefined, { languages: [boot.language === 'zh' ? 'zh-CN' : 'en-US'], preference: boot.language })
ctx.reflect.provide('locale', locale)
ctx.slots.installLocale(locale)
ctx.slots.provideRoot({
  hooks: { sessions: sessionsList, sessionStatus: statuses, panelInfo: panels },
  // The >=alpha.3 Session Controller normally publishes this public resource
  // adapter; keep the same explicit authorized fixture decision for native menus.
  keyedHooks: { sessionAccess: () => ownerAccess },
})
const absentSession = Object.freeze({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
const absentSource = { getSnapshot: () => absentSession, subscribe: () => () => {} }
ctx.slots.installScope('session', { current: absentSource, bindingSource: () => absentSource })
const copy = {
  zh: { sidebarJoinProject: '加入项目', sidebarDragHint: '拖动到项目，或点击选择项目' },
  en: { sidebarJoinProject: 'Add to project', sidebarDragHint: 'Drag to a project, or click to choose a project' },
}
locale.register('native-sidebar-fixture', copy)
const translate = locale.bind('native-sidebar-fixture')
let pluginFiber
const plugin = {
  name: 'native-sidebar-public-registration-fixture', inject: ['slots', 'locale'],
  apply(child) { sidebar.registerNativeSidebar(child, { requestJoin(sessionId, displayTitle) { calls.joined.push({ sessionId, displayTitle }) }, t: translate }) },
}
if (!boot.integration) pluginFiber = await mount(plugin)
let setWide
function FixtureShell({ renderSlot }) {
  const [wide, updateWide] = React.useState(true)
  setWide = updateWide
  return <div className="native-fixture">
    <aside aria-label="Real native workspace browser">
      {renderSlot('sidebar.workspaces', { wide, expandSidebar: () => updateWide(true) })}
    </aside>
    <main style={boot.integration ? { padding: 0, height: '100%', minHeight: 0, overflow: 'hidden' } : undefined}>
      {boot.integration ? renderSlot('main', {}, { key: 'session-dashboard' }) : <>
      <h1>Real SessionNodeItem — isolated controller boundary</h1>
      <p>完整原生 WorkspaceBrowser、SessionNodeItem、Menu 和排序存储；不是在线 GUI。</p>
      <button type="button" data-fallback-candidates onClick={() => calls.joined.push({ fallback: true })}>添加会话 / Add session</button>
      <div data-drop-project="fixture-project" role="region" aria-label="Fixture project drop"
        onDragOver={event => {
          if (!event.dataTransfer.types.includes(sidebar.NATIVE_SIDEBAR_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={event => {
          if (!event.dataTransfer.types.includes(sidebar.NATIVE_SIDEBAR_DRAG_TYPE)) return
          event.preventDefault()
          const source = sidebar.parseNativeSidebarDrag(event.dataTransfer.getData(sidebar.NATIVE_SIDEBAR_DRAG_TYPE))
          if (source) calls.drops.push({ source, projectId: 'fixture-project', types: [...event.dataTransfer.types], plainText: event.dataTransfer.getData('text/plain') })
        }}>项目落点 / Project drop</div>
      <div data-invalid-drop role="region" aria-label="Invalid drop area">无效落点 / Invalid drop</div>
      </>}
      {renderSlot('shell.overlay', {})}
    </main>
  </div>
}
let rootFiber
const rootPlugin = {
  name: 'native-sidebar-fixture-shell', inject: ['slots'],
  apply(child) { child.slots.register({ name: 'root', children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' }, main: { kind: 'single', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } }, FixtureShell) },
}
rootFiber = await mount(rootPlugin)
let workspaceFiber = await mount(workspace)
if (boot.integration) {
  await import('/native/dashboard.js')
  pluginFiber = await mount(modules.get('@hsx/dsh-session-dashboard'))
}
const unmount = ctx.uiRenderer.mount(document.getElementById('root'))
// Keep initial navigation waiting until sessions and an empty Workspace cut are
// both ready. The native restoration then has no target; publishing the real
// fixture membership afterwards must not create or open any Session.
sessionsList.set({ ...sessionsList.getSnapshot(), phase: 'ready', state: 'ready' })
workspaceList.set({ ...workspaceList.getSnapshot(), phase: 'ready', state: 'ready' })
await new Promise(resolve => queueMicrotask(resolve))
workspaceList.set({ ...workspaceList.getSnapshot(), items: [{ workspaceId: 'fixture-workspace', path: '/fixture/workspace', title: 'Fixture workspace', createdAt: '2025-01-01T00:00:00.000Z', sessionIds: Object.keys(summaries) }] })
await new Promise(resolve => requestAnimationFrame(resolve))
window.nativeSidebarFixture = {
  evidence() {
    return {
      loaded, failures, calls,
      slotCounts: Object.fromEntries(['sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item'].map(key => [key, ctx.slots.entries(key).filter(entry => entry.options.id === 'session-dashboard.join-project').length])),
      browserView: JSON.parse(localStorage.getItem('dsh.workspace.view.v5')),
      selected: panels.getSnapshot(),
      visibleOrder: [...document.querySelectorAll('[data-row-key^="session:"]')].map(row => row.getAttribute('data-row-key')),
      realSlotRegistry: ctx.slots instanceof renderer.SlotRegistry,
      sourceModuleExports: Object.keys(workspace).sort(),
    }
  },
  parse: sidebar.parseNativeSidebarDrag,
  async setLanguage(language) { locale.setLocale(language); await new Promise(resolve => requestAnimationFrame(resolve)) },
  setWide(wide) { setWide(wide) },
  async unloadPlugin() { await pluginFiber.dispose() },
  async reloadPlugin() { await pluginFiber.dispose(); pluginFiber = await mount(plugin) },
  async unloadOwner() { await workspaceFiber.dispose() },
  async reloadOwner() { await workspaceFiber.dispose(); workspaceFiber = await mount(workspace) },
  async dispose() { unmount(); for (const fiber of [...fibers].reverse()) await fiber.dispose(); await rootFiber.dispose() },
}
window.dispatchEvent(new Event('native-sidebar-fixture-ready'))
