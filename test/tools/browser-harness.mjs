import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { SessionDashboardRemote } from '../../lib/backend/remote.js'
import { DashboardService } from '../../lib/backend/service.js'
import { DashboardExtensions } from '../../lib/backend/extensions.js'
import { SqliteBoardStore } from '../../lib/backend/store.js'
import { TYPERT } from '../../lib/backend/typert.host.js'
import { observation, FakeHost, mutationFor, replayFixture } from '../helpers.mjs'
import { mountGatewayPrerequisites } from './sdk.mjs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const origin = 'http://dashboard.test'
const fixtureCss = `
/* Test-host CJK fallback: the CI image has no CJK system fonts. Latin still
   resolves through production system-ui; only these glyphs use the OFL subset. */
@font-face{font-family:'Dashboard Fixture CJK';src:url('/fixture-cjk.ttf') format('truetype');font-weight:400;font-style:normal;font-display:block;unicode-range:U+3000-303F,U+3400-9FFF,U+FF00-FFEF}
.fixture-shell,.fixture-shell .sd-root,.fixture-shell .sd-root *{font-family:'Dashboard Fixture CJK',system-ui,sans-serif!important}
html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}body{font:14px system-ui,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
:root{--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#f4f5f8;--dsw-alias-label-primary:#20242b;--dsw-alias-label-secondary:#58606c;--dsw-alias-border-l3:#d5dae2;--dsw-alias-brand-primary:#455bb5;--dsw-alias-label-primary-foreground:#ffffff}
html[data-fixture-theme=dark]{color-scheme:dark;--dsw-alias-bg-base:#1c1f26;--dsw-alias-bg-layer-1:#262b35;--dsw-alias-label-primary:#f0f2f7;--dsw-alias-label-secondary:#b5bdcd;--dsw-alias-border-l3:#4b5361;--dsw-alias-brand-primary:#5366bb;--dsw-alias-label-primary-foreground:#ffffff}
.fixture-shell{display:grid;grid-template-columns:164px minmax(0,1fr);height:100%;min-width:0}.fixture-shell aside{background:var(--dsw-alias-bg-layer-1);padding:14px 8px;border-right:1px solid var(--dsw-alias-border-l3);min-width:0}.fixture-scope{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:0 4px 12px}.fixture-shell aside button{display:flex;align-items:center;gap:9px;width:100%;padding:10px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.fixture-shell aside button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base)}.fixture-shell>main{min-width:0;min-height:0;overflow:hidden}.fixture-peer{padding:30px}.fixture-shell button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media(max-width:800px){.fixture-shell{grid-template-columns:56px minmax(0,1fr)}.fixture-shell aside button span:not([aria-hidden]){display:none}.fixture-scope{font-size:8px}.fixture-shell aside{padding:8px 4px}.fixture-shell aside button{padding:9px}}
`

async function removeTemporaryDirectory(path) {
  const absolute = await realpath(path)
  const expectedParent = await realpath(tmpdir())
  assert.equal(dirname(absolute), expectedParent, 'cleanup must target an immediate temporary child')
  assert.match(absolute.slice(expectedParent.length + 1), /^session-dashboard-browser-/)
  await rm(absolute, { recursive: true, force: true })
}

/** Native scripts are package artifacts, loaded intact by their real factory.
 * Resolution is local-only; there is deliberately no global SDK/source fallback. */
export async function createBrowserRuntime({ secureContext = true } = {}) {
  const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
  await access(executablePath, constants.X_OK).catch(error => { throw new Error(`Chrome executable is required at ${executablePath}; set CHROME_PATH explicitly`, { cause: error }) })
  const directory = await mkdtemp(join(tmpdir(), 'session-dashboard-browser-assets-'))
  try {
    const dashboardPath = join(root, 'lib/client.js')
    await access(dashboardPath).catch(error => { throw new Error('Build the plugin first: npm run build (native lib/client.js is required)', { cause: error }) })
    const scripts = new Map()
    for (const [route, specifier] of [
      ['/native/renderer.js', '@deepseek-ai/dsh-client-ui-renderer/client'],
      ['/native/locale.js', '@deepseek-ai/dsh-client-locale/client'],
    ]) scripts.set(route, await readFile(require.resolve(specifier), 'utf8'))
    scripts.set('/native/dashboard.js', await readFile(dashboardPath, 'utf8'))
    const font = await readFile(join(root, 'test/browser/fonts/noto-sans-sc-subset.ttf'))
    const fontSource = JSON.parse(await readFile(join(root, 'test/browser/fonts/source.json'), 'utf8'))
    assert.equal(createHash('sha256').update(font).digest('hex'), fontSource.sha256, 'test font must match documented source checksum')
    const bundle = join(directory, 'fixture.js')
    await build({ entryPoints: [join(root, 'test/browser/fixture.jsx')], outfile: bundle, absWorkingDir: root, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', external: ['/native/*'], define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
    scripts.set('/fixture.js', await readFile(bundle, 'utf8'))
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...(secureContext ? [`--unsafely-treat-insecure-origin-as-secure=${origin}`] : [])] })
    return { browser, scripts, font, executablePath, async close() { await browser.close(); await removeTemporaryDirectory(directory) } }
  } catch (error) { await removeTemporaryDirectory(directory); throw error }
}

export function sessionObservation(title, phase = 'completed', episode = 'turn:1', extra = {}) {
  return { ...observation(phase, episode, { startedAt: phase === 'not_started' ? null : 1735689600000, endedAt: phase === 'completed' ? 1735689600200 : null, ...extra }), title, activityAt: 1735689600200 }
}

export async function createFixture(t, runtime, name, { viewport = { width: 1440, height: 1050 }, theme = 'light', initialFailure = false, nativeSidebarRuntime = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-dashboard-browser-data-'))
  const databasePath = join(directory, 'dashboard.sqlite')
  let store, service, fibers = [], ctx
  const host = new FakeHost()
  const reports = []
  const calls = []
  const waiters = new Set()
  let time = 1735689601000
  let bootFailure = initialFailure
  const startService = async () => {
    store = new SqliteBoardStore(databasePath)
    service = new DashboardService(store, host, error => reports.push(String(error)), () => ++time)
    ctx = new Context()
    const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await(); assert.equal(fiber.error, undefined) }
    let connection
    await mount(scope => { connection = new HostConnectionService(scope, [], { isAuthenticated: request => new Headers(request.headers).get('x-fixture-browser') === 'authenticated' }) })
    await mount(Registry)
    ctx.typert.register(TYPERT)
    let extensions
    await mount({ apply(scope) { extensions = new DashboardExtensions(scope, store, service) } })
    class FixtureDashboardRemote extends SessionDashboardRemote { constructor(scope) { super(scope, service, extensions) } }
    await mount(FixtureDashboardRemote)
    const access = await mountGatewayPrerequisites(ctx); if (access) fibers.push(access)
    await mount(Gateway, {})
    assert(ctx.typertGateway, 'the locally installed strict Typert Gateway must mount')
    const carrier = connection.createSharedFetchHandler('/api')
    return async (method, args) => {
      const rpcId = randomUUID(), endpoint = `sessionDashboard/${method}`
      const admission = connection.admit({ headers: new Headers({ host: 'localhost', 'x-fixture-browser': 'authenticated' }) })
      assert.ok(admission.peer, 'isolated browser credential must be admitted by real Connection')
      const response = await carrier.fetch(new Request(`http://localhost/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }) }), admission.peer)
      assert.equal(response.status, 200)
      const envelope = await response.json(); assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, rpcId)
      return envelope.result
    }
  }
  const stopService = async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    fibers = []
    await service.close()
  }
  let rpc = await startService()
  let context, page, nativeFixture
  const attachRpc = async target => {
    await target.exposeBinding('dashboardRpc', async (_source, method, args) => {
      let result
      try {
        if (bootFailure && method === 'snapshot') throw new Error('fixture initial transport unavailable')
        result = await rpc(method, args)
      } catch (error) {
        result = { ok: false, error: { isDSHRemoteError: true, code: error.code || 'remote/error', message: error.message, details: error.details ?? null } }
      }
      const call = { method, args: structuredClone(args), result: structuredClone(result), boardRevision: store.read().revision }
      calls.push(call)
      for (const waiter of [...waiters]) if (waiter.predicate(call)) { waiters.delete(waiter); waiter.resolve(call) }
      return result
    })
  }
  if (nativeSidebarRuntime) {
    nativeFixture = await nativeSidebarRuntime.fixture(t, name, { integration: true, width: viewport.width, setupPage: attachRpc })
    page = nativeFixture.page; context = nativeFixture.context
  } else {
    context = await runtime.browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'UTC', colorScheme: theme, serviceWorkers: 'block' })
    page = await context.newPage()
    // The preview's Open session in a new tab link loads a full plugin page in a
    // popup. Expose the real Gateway transport to the whole context so that tab
    // mounts (and reads its snapshot) exactly like the parent page.
    await attachRpc(context)
  }
  page.setDefaultTimeout(12000)
  page.setDefaultNavigationTimeout(20000)
  const pageErrors = []
  const unexpectedRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // Context-level routing also covers tabs the fixture opens (the preview's native
  // new tab); a page-level route would leave that popup hitting the live origin.
  if (!nativeSidebarRuntime) await page.context().route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { unexpectedRequests.push(url.href); await route.abort('blockedbyclient'); return }
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN" data-fixture-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session Dashboard native-slot fixture</title><style>${fixtureCss}</style></head><body${theme === 'dark' ? ' data-ds-dark-theme' : ''}><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>` })
    } else if (url.pathname === '/fixture-cjk.ttf') await route.fulfill({ contentType: 'font/ttf', body: runtime.font })
    else if (runtime.scripts.has(url.pathname)) await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: runtime.scripts.get(url.pathname) })
    else if (url.pathname === '/favicon.ico') await route.fulfill({ status: 204 })
    // The dashboard's own extension system asks the Host for its list on mount.
    // The fixture serves an empty one: no external module is imported here.
    else if (url.pathname === '/api/session-dashboard/extensions') await route.fulfill({ contentType: 'application/json; charset=utf-8', body: JSON.stringify({ directory: null, entries: [] }) })
    else if (url.pathname === '/api/session-dashboard/extensions/enabled') await route.fulfill({ status: 404, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'not served by the fixture' }) })
    else { unexpectedRequests.push(url.href); await route.abort('blockedbyclient') }
  })
  const screenshot = async suffix => {
    const path = join(root, 'artifacts/browser', `${name}${suffix ? `-${suffix}` : ''}.png`)
    await mkdir(dirname(path), { recursive: true })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path, fullPage: true })
    return path
  }
  t.after(async () => {
    try {
      if (!page.isClosed()) await screenshot('final')
      await writeFile(join(root, 'artifacts', `${name}-rpc.json`), JSON.stringify({ calls, board: store.read(), visibleDialogs: page.isClosed() ? [] : await page.locator('[role="dialog"]').allTextContents() }, null, 2) + '\n')
      if (!page.isClosed()) await page.evaluate(() => window.dashboardFixture?.dispose())
      assert.deepEqual(pageErrors, [], 'Chrome must not report uncaught page errors')
      if (!page.isClosed()) assert.deepEqual(await page.evaluate(() => window.dashboardFixture?.failures ?? []), [], 'Cordis must not report internal plugin errors')
      assert.deepEqual(unexpectedRequests, [], 'the fixture must never contact live services or external origins')
      assert.deepEqual(reports, [], 'the real dashboard service must not report unexpected errors')
    } finally { await context.close(); await stopService(); await removeTemporaryDirectory(directory) }
  })
  const h = {
    page, host, calls, databasePath, pageErrors, unexpectedRequests, nativeFixture,
    get store() { return store },
    get service() { return service },
    board: () => store.read(),
    card: id => store.read().cards.find(card => card.sessionId === id),
    /** Explicit synthetic replay for UI-only review tests; never default proof. */
    setReplay(id, value) { host.setSource(id, replayFixture(id, value.runtime)) },
    setObservation: async (id, value, { completeReplay = false } = {}) => {
      host.set(id, value)
      if (completeReplay) host.setSource(id, replayFixture(id, value.runtime))
      await service.snapshot()
    },
    setInitialFailure(value) { bootFailure = value },
    async restartService() { await stopService(); host.closed = false; rpc = await startService() },
    failDatabaseWrites() {
      const db = new DatabaseSync(databasePath)
      try { db.exec("CREATE TRIGGER browser_write_failure BEFORE UPDATE ON board BEGIN SELECT RAISE(ABORT, 'browser-fixture-disk-write-failure'); END;") } finally { db.close() }
    },
    allowDatabaseWrites() {
      const db = new DatabaseSync(databasePath)
      try { db.exec('DROP TRIGGER browser_write_failure') } finally { db.close() }
    },
    screenshot,
    nextCall(predicate) {
      return new Promise((resolveCall, reject) => {
        const waiter = { predicate, resolve: call => { clearTimeout(timer); resolveCall(call) } }
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Expected browser RPC was not observed')) }, 8000)
        waiters.add(waiter)
      })
    },
    async mutate(command) { return service.mutate(mutationFor(service, command)) },
    async inspect(sessionId) { return service.inspectSession({ sessionId }) },
    async join(sessionId, projectId = null) {
      const { binding: inspection } = await service.inspectSession({ sessionId })
      return service.mutate(mutationFor(service, { type: 'add_card', sessionId, projectId, inspection }))
    },
    async setEntry(entry, changes = {}) {
      const { revision, ...value } = store.read().preferences
      await service.mutate(mutationFor(service, { type: 'preferences', expectedRevision: revision, value: { ...value, entry, ...changes } }))
    },
    async openDashboard() {
      if (nativeSidebarRuntime) { await page.locator('[data-sd-home]').waitFor(); return }
      await page.goto(origin)
      await page.waitForFunction(() => Boolean(window.dashboardFixture))
      await page.locator('[data-fixture-nav="session-dashboard"]').click()
      await page.locator('[data-sd-home]').waitFor()
      await page.waitForFunction(() => !document.querySelector('.sd-root')?.textContent.includes('正在加载会话仪表板…'))
      await page.evaluate(async () => { await document.fonts.ready; if (!document.fonts.check('14px "Dashboard Fixture CJK"', '会话仪表板')) throw new Error('CJK fixture font did not load') })
    },
  }
  return h
}

export async function mutation(h, type, action, { ok = true } = {}) {
  const next = h.nextCall(call => call.method === 'mutate' && call.args.mutation.command.type === type)
  await action()
  const call = await next
  assert.equal(call.result.ok, ok, `${type} returned ${JSON.stringify(call.result)}`)
  await h.page.waitForFunction(() => !document.querySelector('.sd-summary')?.textContent.includes('正在保存…'))
  return call
}

export async function persistedPreferences(h, predicate, action) {
  const next = h.nextCall(call => call.method === 'mutate' && call.args.mutation.command.type === 'preferences' && call.result.ok && predicate(call.result.value.board.preferences))
  await action()
  await next
}

const morePanel = page => page.getByRole('group', { name: '更多操作', exact: true })
/** The rare title-bar actions live behind the persistent three-dot trigger. Opening
 *  is idempotent so helpers never toggle an already-open menu shut. */
export async function openMenu(page) {
  const trigger = page.getByRole('button', { name: '更多操作', exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await morePanel(page).waitFor()
}
export async function closeMenu(page) {
  if (await page.locator('.sd-pop').count() === 0) return
  await page.keyboard.press('Escape')
  await page.locator('.sd-pop').waitFor({ state: 'detached' })
}
export const projectDrop = page => page.locator('.sd-projectdrop')
/** Every project expands by default; this helper returns that project's own panel,
 *  opening it only when it has been collapsed. */
export function projectDropFor(page, name) {
  return page.getByRole('article', { name, exact: true }).locator('.sd-projectdrop')
}
export async function openProjectDrop(page, name) {
  const trigger = page.getByRole('button', { name, exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const panel = projectDropFor(page, name)
  await panel.waitFor()
  return panel
}
/** Drop the native sidebar's own drag payload onto a project card. The native
 *  handle is registered by the host; this drives the same MIME contract. */
export async function projectDropNative(page, name, payload) {
  await page.evaluate(({ name, payload }) => {
    const target = [...document.querySelectorAll('.sd-projectcard')].find(node => node.querySelector('.sd-projectname')?.textContent === name)
    if (!target) throw new Error(`project drop target ${name} not found`)
    const data = new DataTransfer()
    data.setData('application/x-session-dashboard-native-session', JSON.stringify(payload))
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }))
  }, { name, payload })
  await page.getByText(/项目成员关系已保存|会话已保存/).waitFor()
}
export async function closeProjectDrop(page, name) {
  const trigger = name === undefined
    ? null
    : page.getByRole('button', { name, exact: true })
  if (trigger) {
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    return
  }
  const expanded = page.locator('.sd-projecttoggle[aria-expanded="true"]')
  while (await expanded.count() > 0) await expanded.first().click()
}
/** 项目总览 is the only top-level view: a project card is the project's whole
 *  surface now, so this returns its session list instead of a column board. */
export async function projectSessions(page, name) {
  return openProjectDrop(page, name)
}
/** 未归属/已归档 sessions live in collapsed sections at the bottom of 项目总览. */
export async function expandBucket(page, bucket = 'unassigned') {
  const toggle = page.getByRole('button', { name: bucket === 'archive' ? /已归档会话/ : /未归属会话/ })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  return page.locator(`.sd-bucket[data-bucket="${bucket}"]`)
}
/** Open a session row's own menu (rename / fork / archive / details). */
export async function openRowMenu(page, title, bucket = 'unassigned') {
  const trigger = page.getByRole('button', { name: `会话行操作：${title}`, exact: true })
  // A project row is already visible in the default expansion; bucket rows need theirs opened.
  if (await trigger.count() === 0) await expandBucket(page, bucket)
  if (await trigger.getAttribute('aria-expanded') !== 'true') { await waitUncovered(page, trigger); await trigger.click() }
  const panel = page.getByRole('group', { name: `会话行操作：${title}`, exact: true })
  await panel.waitFor()
  return panel
}
export async function openDetailsFromRow(page, title, bucket = 'unassigned') {
  const menu = await openRowMenu(page, title, bucket)
  await menu.getByRole('button', { name: '会话详情', exact: true }).click()
  const details = drawer(page)
  await details.waitFor()
  return details
}
/** The row state chip is the only acceptance/state surface now. */
export async function openStatePanel(page, title) {
  const trigger = page.getByRole('button', { name: `更改状态：${title}`, exact: true })
  await trigger.click()
  const panel = page.getByRole('listbox', { name: `更改状态：${title}`, exact: true })
  await panel.waitFor()
  return panel
}

/** A viewport or locale change lands asynchronously. Let the resize and the render
 * settle first: the panel dismisses on a resize, so opening it in the same tick as a
 * pending viewport change would close it immediately. */
export async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
}

/** Focus a control, prove it really owns focus, then press one key. A snapshot
 * refresh or a remount between focus() and the keypress would otherwise deliver the
 * key to the body and the reorder would silently never happen. */
export async function pressOn(page, locator, key) {
  const handle = await locator.elementHandle()
  await locator.focus()
  await page.waitForFunction(element => document.activeElement === element, handle)
  await page.keyboard.press(key)
}

/** Wait until the control is the element a pointer would actually hit. A preview or
 * New Session overlay that is still opening (or still being dismissed) covers the
 * board for a while on a slow host, and a click sent into it silently goes nowhere. */
export async function waitUncovered(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const handle = await locator.elementHandle()
  await page.waitForFunction(element => {
    if (!element || !element.isConnected) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    // A row far below the fold has no hit point at all; bring it into view first
    // instead of waiting for an overlay that is not the problem.
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) { element.scrollIntoView({ block: 'center', inline: 'center' }); return false }
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit) && (element === hit || element.contains(hit) || hit.contains(element))
  }, handle)
}

export async function refresh(h) {
  const next = h.nextCall(call => call.method === 'snapshot')
  // A modal deliberately blocks toolbar clicks. In that case use the actual
  // visible-panel polling lifecycle instead of clicking through the overlay.
  if (await h.page.getByRole('dialog').count() === 0) {
    await openMenu(h.page)
    await h.page.getByRole('button', { name: '刷新数据', exact: true }).click()
    await morePanel(h.page).waitFor({ state: 'detached' })
  }
  await next
}

export async function createLabel(h, dimension, name) {
  const page = h.page
  if (dimension === 'project') {
    await h.mutate({ type: 'create_project', name, color: null, tagIds: [] })
    await refresh(h)
    return h.board().projects.find(project => project.name === name)
  }
  await openMenu(page)
  if (await page.getByRole('button', { name: '分类与排列', exact: true }).count() === 0) {
    await closeMenu(page)
    await h.setEntry('projects')
    await refresh(h)
    await page.locator('.sd-projectgrid').waitFor()
    await openMenu(page)
  }
  await page.getByRole('button', { name: '分类与排列', exact: true }).click()
  await morePanel(page).waitFor({ state: 'detached' })
  const dialog = page.getByRole('dialog', { name: '分类与展示排列', exact: true })
  await dialog.getByRole('button', { name: { project: '项目', tag: '普通标签', status: '状态' }[dimension], exact: true }).click()
  // A manager section starts collapsed: its summary is all the default view shows,
  // so the create form only exists after the dimension's section is opened.
  if (dimension === 'tag') {
    const head = dialog.getByRole('button', { name: /^普通标签 / })
    if (await head.getAttribute('aria-expanded') === 'false') await head.click()
  }
  await dialog.getByLabel({ project: '项目名称', tag: '普通标签名称', status: '状态名称' }[dimension], { exact: true }).fill(name)
  await mutation(h, 'create_label', () => dialog.getByRole('button', { name: dimension === 'status' ? '新建状态' : '创建分类', exact: true }).click())
  await dialog.getByRole('button', { name: '关闭分类与展示排列', exact: true }).click()
  return (dimension === 'project' ? h.board().projects : dimension === 'status' ? h.board().statuses : h.board().tags).find(label => label.name === name)
}

/** Point the fixture's host-native pickers at one already seeded Host Session.
 *  Creating a Session is a Client Session Controller call, so the id is the only
 *  thing the browser needs; the Dashboard then joins it through real RPC. */
export async function prepareNewSession(page, { sessionId, workspaceId = 'fixture-workspace', title = 'Fixture workspace', path = '/fixture/workspace' }) {
  await page.evaluate(({ sessionId, workspace }) => {
    window.dashboardFixture.workspaces = [workspace]
    window.dashboardFixture.createSessionId = sessionId
    window.dashboardFixture.createdWith = null
    window.dashboardFixture.prompted = null
    window.dashboardFixture.promptResult = null
  }, { sessionId, workspace: { workspaceId, title, path } })
}

/** Confirms the workspace picker that every New session opens. The first row is
 *  preselected; the returned mutation is the real add_card join. */
export async function pickWorkspaceAndCreate(h, { title, prompt } = {}) {
  const dialog = h.page.getByRole('dialog', { name: '新建会话', exact: true })
  await dialog.waitFor()
  const radio = title === undefined ? dialog.getByRole('radio').first() : dialog.getByRole('radio', { name: title, exact: true })
  await radio.check()
  if (prompt !== undefined) await dialog.getByLabel('启动内容（可选）', { exact: true }).fill(prompt)
  const result = await mutation(h, 'add_card', () => dialog.getByRole('button', { name: '在这里新建', exact: true }).click())
  // Creation dismisses the native New Session overlay asynchronously. A slower host
  // (isolated install or CI) would otherwise keep its pending frame over the board and
  // swallow the next click, so wait for the overlay to go before reporting success.
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
  return result
}

/** Close the floating preview if creation opened one. */
export async function closePreview(page) {
  // Creation can open the preview slightly after the notice, and a second window may
  // follow a first close, so keep closing while a visible preview is still up.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const preview = page.getByRole('dialog', { name: '预览会话', exact: true })
    if (await preview.count() === 0 || !(await preview.isVisible())) break
    const close = preview.getByRole('button', { name: '关闭预览会话', exact: true })
    if (await close.count() === 0) break
    await close.click()
    await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
    await settleLayout(page)
  }
  await page.waitForFunction(() => [...document.querySelectorAll('[data-preview-cache]')].every(node => node.hasAttribute('hidden')))
}

/** Join a seeded Host Session to a project through the dashboard's only creation
 *  entry: Project actions → New session. The picker and Session Controller are
 *  fixture-owned, while inspection and add_card stay real. */
export async function addCard(h, { title, project }) {
  const page = h.page
  const id = [...h.host.values].find(([, value]) => value.title === title)?.[0]
  assert.ok(id, `fixture session titled ${title} exists`)
  if (project === '未归属') {
    await h.join(id)
    // The visible overview poll picks the new unassigned row up; no preference write races it.
    await page.getByRole('button', { name: /未归属会话/ }).waitFor({ timeout: 8000 })
    await openDetailsFromRow(page, title, 'unassigned')
    return
  }
  assert.ok(h.board().projects.some(row => row.name === project), `fixture project ${project} exists`)
  if (h.board().preferences.entry !== 'projects') { await h.setEntry('projects'); await refresh(h) }
  await prepareNewSession(page, { sessionId: id })
  const card = page.getByRole('article', { name: project, exact: true })
  await card.getByRole('button', { name: `项目操作：${project}`, exact: true }).click()
  await card.getByRole('group', { name: `项目操作：${project}`, exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
  await pickWorkspaceAndCreate(h)
  await page.getByText('新会话已创建并加入项目。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'a determined project applies without the confirmation dialog')
  // Creation guides the user into the native preview; close it before opening details.
  await closePreview(page)
  const trigger = page.getByRole('button', { name: `会话行操作：${title}`, exact: true })
  await trigger.waitFor({ timeout: 8000 })
  await waitUncovered(page, trigger)
  await trigger.click()
  await page.getByRole('group', { name: `会话行操作：${title}`, exact: true }).getByRole('button', { name: '会话详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情', exact: true })
  await details.waitFor()
}

export const drawer = page => page.getByRole('dialog', { name: '会话详情', exact: true })
export const closeDrawer = page => drawer(page).getByRole('button', { name: '关闭会话详情', exact: true }).click()
/** Opening a finished round confirms it asynchronously; wait for the acceptance path to arm. */
/** Move a finished round from 待确认 to 待验收 the way opening it would. */
export async function confirmReviewCard(h, sessionId) {
  const card = h.card(sessionId)
  if (!card || card.status !== 'pending_confirm') return
  await h.mutate({ type: 'confirm_review', sessionId, membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision, expectedLifecycleRevision: card.lifecycleRevision, expectedWorkflowRevision: card.workflowRevision, episodeId: card.runtime.episodeId })
  await refresh(h)
}
export async function reviewReady(page) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('验收通过'))
    return button !== undefined && !button.disabled
  })
}
export async function expectCardStatus(page, id, status) {
  await page.locator(`[data-card-id="${id}"] [data-status="${status}"]`).waitFor({ state: 'visible' })
}
