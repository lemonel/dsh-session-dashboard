import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

export const pluginRoot = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'http://native-sidebar.test'
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) }
const digest = value => createHash('sha256').update(value).digest('hex')

/** An explicit SDK root is exclusive. A missing local package never falls back globally. */
export async function resolveNativeSidebarSdk(hostRoot = process.env.DSH_SIDEBAR_HOST_ROOT || pluginRoot) {
  const root = resolve(hostRoot)
  const nodeModules = await realpath(root.endsWith('node_modules') ? root : join(root, 'node_modules'))
  const packages = {}
  for (const name of ['dsh-web-frontend', 'dsh-client-ui-workspace', 'dsh-client-ui-renderer', 'dsh-client-locale']) {
    const directory = await realpath(join(nodeModules, '@deepseek-ai', name))
    assert(inside(nodeModules, directory), `Selected SDK package escaped ${nodeModules}`)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `@deepseek-ai/${name}`)
    packages[name] = { directory, version: manifest.version }
  }
  const version = packages['dsh-client-ui-workspace'].version
  for (const item of Object.values(packages)) assert.equal(item.version, version, 'The real frontend and workspace must come from the same selected SDK version')
  return { root, nodeModules, version, packages }
}

async function removeTemporaryDirectory(directory) {
  const absolute = await realpath(directory)
  const parent = await realpath(tmpdir())
  assert.equal(dirname(absolute), parent)
  assert.match(absolute.slice(parent.length + 1), /^session-dashboard-native-sidebar-/)
  await rm(absolute, { recursive: true, force: true })
}

/** Load the selected host's COMPLETE, UNMODIFIED web shell and workspace factory.
 * The shell's ModuleLoader.create seam hands its real React/atoms/store baseline
 * to a fixture module loader. Only controller data and external actions are fake;
 * WorkspaceBrowser, SessionNodeItem, Menu and native ordering stores are real. */
export async function createNativeSidebarRuntime({ hostRoot } = {}) {
  const sdk = await resolveNativeSidebarSdk(hostRoot)
  const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
  await access(executablePath, constants.X_OK)
  const directory = await mkdtemp(join(tmpdir(), 'session-dashboard-native-sidebar-'))
  let browser
  try {
    const webRoot = join(sdk.packages['dsh-web-frontend'].directory, 'dist')
    const index = await readFile(join(webRoot, 'index.html'), 'utf8')
    const entry = index.match(/<script\b[^>]*\bsrc="\.\/([^\"]+)"/)
    assert(entry, 'The selected real frontend must have its module entry')
    const styles = [...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^\"]+)"/g)].map(match => match[1])
    const scripts = new Map()
    const evidence = { kind: 'real-native-sidebar-browser', version: sdk.version, sdkRoot: sdk.root, frontend: {}, workspace: {}, fixture: 'intact factory via public ModuleLoader.create staticModules seam; isolated fake controller boundaries; not the live GUI' }
    for (const [route, name] of [['renderer', 'dsh-client-ui-renderer'], ['locale', 'dsh-client-locale'], ['workspace', 'dsh-client-ui-workspace']]) {
      const text = await readFile(join(sdk.packages[name].directory, 'lib/client.js'), 'utf8')
      scripts.set(`/native/${route}.js`, text)
      if (route === 'workspace') {
        assert(text.includes('function SessionNodeItem('), 'No copied/substituted native SessionNodeItem is permitted')
        evidence.workspace = { path: join(sdk.packages[name].directory, 'lib/client.js'), sha256: digest(text), untouched: true }
      }
    }
    const shell = await readFile(join(webRoot, entry[1]))
    evidence.frontend = { path: join(webRoot, entry[1]), sha256: digest(shell), untouched: true }
    const moduleResult = await build({ entryPoints: [join(pluginRoot, 'src/frontend/native-sidebar.tsx')], absWorkingDir: pluginRoot, bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' })
    assert(moduleResult.outputFiles[0])
    scripts.set('/native/sidebar.js', `window.__ModuleLoader__.load({id:'session-dashboard/native-sidebar-test',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${moduleResult.outputFiles[0].text}\nreturn module.exports;}});`)
    const fixtureResult = await build({ entryPoints: [join(pluginRoot, 'test/browser/native-sidebar-fixture.jsx')], absWorkingDir: pluginRoot, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', external: ['/native/*'], logLevel: 'silent' })
    assert(fixtureResult.outputFiles[0])
    scripts.set('/fixture.js', fixtureResult.outputFiles[0].text)
    const font = await readFile(join(pluginRoot, 'test/browser/fonts/noto-sans-sc-subset.ttf'))
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', `--unsafely-treat-insecure-origin-as-secure=${origin}`] })
    return {
      browser, sdk, evidence,
      async fixture(t, name, { language = 'zh', groupBy = 'workspace', orderBy = 'updated', width = 1280, integration = false, setupPage } = {}) {
        const context = await browser.newContext({ viewport: { width, height: 850 }, locale: language === 'en' ? 'en-US' : 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' })
        const page = await context.newPage()
        const errors = [], requests = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        page.setDefaultTimeout(8000)
        if (setupPage) await setupPage(page)
        const productionClient = integration ? await readFile(join(pluginRoot, 'lib/client.js'), 'utf8') : null
        await page.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.origin !== origin) { requests.push(url.href); await route.abort(); return }
          if (url.pathname === '/') {
            await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map(path => `<link rel="stylesheet" href="/host/${path}">`).join('')}<style>@font-face{font-family:NativeSidebarFixtureCJK;src:url('/fixture-cjk.ttf');font-display:block;unicode-range:U+3000-303F,U+3400-9FFF,U+FF00-FFEF}html,body,#root{margin:0;height:100%;font-family:system-ui,NativeSidebarFixtureCJK,sans-serif}body{background:#fff;color:#20242b}.native-fixture{display:grid;grid-template-columns:340px minmax(0,1fr);height:100%;min-height:0}.native-fixture aside{border-right:1px solid #ccd2dc;min-height:0;display:flex;flex-direction:column;padding:8px}.native-fixture main{padding:24px;min-width:0}.native-fixture [data-drop-project]{margin-top:24px;padding:45px 20px;border:2px dashed #5266c9}.native-fixture [data-invalid-drop]{margin-top:30px;min-height:180px;background:#f4f5f8;padding:20px}.native-fixture .sd-root,.native-fixture .sd-root *{font-family:system-ui,NativeSidebarFixtureCJK,sans-serif!important}.native-fixture button{font:inherit}.native-fixture h1{font-size:21px}.native-fixture p{margin:8px 0}@media(max-width:700px){.native-fixture{grid-template-columns:260px minmax(0,1fr)}.native-fixture main{padding:10px}}</style></head><body><div id="root"></div><script>window.nativeSidebarBoot=${JSON.stringify({ language, groupBy, orderBy, integration, shellEntry: '/host/' + entry[1], evidence })}</script><script type="module" src="/fixture.js"></script></body></html>` })
          } else if (url.pathname === '/fixture-cjk.ttf') await route.fulfill({ contentType: 'font/ttf', body: font })
          else if (url.pathname === '/native/dashboard.js' && productionClient) await route.fulfill({ contentType: 'text/javascript', body: productionClient })
          else if (scripts.has(url.pathname)) await route.fulfill({ contentType: 'text/javascript', body: scripts.get(url.pathname) })
          else if (url.pathname.startsWith('/host/')) {
            const asset = resolve(webRoot, decodeURIComponent(url.pathname.slice(6)))
            assert(inside(webRoot, asset), 'Asset path escaped selected frontend')
            if (!(await stat(asset)).isFile()) throw new Error(`Missing selected host asset ${asset}`)
            await route.fulfill({ contentType: asset.endsWith('.css') ? 'text/css' : asset.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: await readFile(asset) })
          } else if (url.pathname === '/favicon.ico') await route.fulfill({ status: 204 })
          // The dashboard asks the Host for its own extension list on mount.
          else if (url.pathname === '/api/session-dashboard/extensions') await route.fulfill({ contentType: 'application/json; charset=utf-8', body: JSON.stringify({ directory: null, entries: [] }) })
          else { requests.push(url.href); await route.abort() }
        })
        t.after(async () => {
          try {
            await mkdir(join(pluginRoot, 'artifacts/browser'), { recursive: true })
            await page.screenshot({ path: join(pluginRoot, 'artifacts/browser', `native-sidebar-${name}.png`), fullPage: true })
            const result = await page.evaluate(() => window.nativeSidebarFixture?.evidence())
            await writeFile(join(pluginRoot, 'artifacts', `native-sidebar-${name}.json`), JSON.stringify({ ...evidence, ...result, errors, unexpectedRequests: requests }, null, 2) + '\n')
            await page.evaluate(() => window.nativeSidebarFixture?.dispose())
            assert.deepEqual(errors, [], 'The complete real native browser composition must not report errors')
            assert.deepEqual(requests, [], 'No live host or external origin may be contacted')
          } finally { if (!integration) await context.close() }
        })
        await page.goto(origin)
        await page.waitForFunction(() => Boolean(window.nativeSidebarFixture))
        await page.locator('[data-row-key="session:native-a"]').waitFor()
        await page.evaluate(() => document.fonts.ready)
        return { page, context, errors, requests, snapshot: () => page.evaluate(() => window.nativeSidebarFixture.evidence()) }
      },
      async close() { await browser.close(); await removeTemporaryDirectory(directory) },
    }
  } catch (error) { await browser?.close(); await removeTemporaryDirectory(directory); throw error }
}

export async function nativeDrag(page, source, through, destination, { cancel = false } = {}) {
  const sessionId = await source.getAttribute('data-sd-native-session')
  if (sessionId) await page.locator(`[data-row-key="session:${sessionId}"]`).hover()
  const first = await source.boundingBox()
  assert(first, 'Drag source must have real browser geometry')
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2 + 4, first.y + first.height / 2 + 2, { steps: 3 })
  await page.mouse.move(first.x + first.width / 2 + 28, first.y + first.height / 2 + 2, { steps: 6 })
  for (const target of [...through, ...(destination ? [destination] : [])]) {
    const box = await target.boundingBox()
    assert(box)
    await page.mouse.move(box.x + Math.min(box.width / 2, 90), box.y + box.height * 0.7, { steps: 12 })
    // Chromium needs two moves at the same target to dispatch dragover reliably.
    await page.mouse.move(box.x + Math.min(box.width / 2, 90) + 1, box.y + box.height * 0.7, { steps: 2 })
  }
  if (cancel) await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
