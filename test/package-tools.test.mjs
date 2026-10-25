import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot'
import { API_VERSION, LOCALE_PATHS, PACKAGE_NAME, PUBLIC_DOCUMENTS, RPC_METHODS, assertLocalizedMetadata, assertPackageFiles, assertPublicContract } from './tools/package-contract.mjs'
import { snapshotProject, sourceFingerprint } from './tools/matrix.mjs'
import { npmCommand } from './tools/process.mjs'

test('npm launcher resolves the Windows JavaScript CLI without a cmd shell or quoting', () => {
  const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe', npmExecPath = 'C:\\tool cache\\npm\\bin\\npm-cli.js'
  const selected = npmCommand({ nodeExecutable, npmExecPath, platform: 'win32', exists: path => path === npmExecPath })
  assert.deepEqual(selected, { command: nodeExecutable, prefix: [npmExecPath] })
  const standard = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmCommand({ nodeExecutable, npmExecPath: null, platform: 'win32', exists: path => path === standard }), { command: nodeExecutable, prefix: [standard] })
  assert.equal(selected.command.endsWith('.cmd'), false)
})

test('npm launcher uses only standard Node paths and rejects an invalid explicit CLI without fallback', () => {
  const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js'
  assert.deepEqual(npmCommand({ nodeExecutable: '/opt/node/bin/node', npmExecPath: null, platform: 'linux', exists: path => path === cli }), { command: '/opt/node/bin/node', prefix: [cli] })
  assert.throws(() => npmCommand({ nodeExecutable: '/opt/node/bin/node', npmExecPath: null, platform: 'linux', exists: () => false }), error => error.code === 'NPM_CLI_UNAVAILABLE')
  let fallbacks = 0
  assert.throws(() => npmCommand({ nodeExecutable: '/opt/node/bin/node', npmExecPath: '/unavailable/npm-cli.js', platform: 'linux', exists: path => { if (path !== '/unavailable/npm-cli.js') fallbacks++; return path === cli } }), error => error.code === 'NPM_CLI_UNAVAILABLE')
  assert.equal(fallbacks, 0)
  for (const bad of ['npm.cmd', '/opt/node/bin/npm.cmd', '/opt/node/bin/yarn.js', 'npm-cli.js']) assert.throws(() => npmCommand({ nodeExecutable: '/opt/node/bin/node', npmExecPath: bad, platform: 'linux', exists: () => true }), error => error.code === 'NPM_CLI_UNAVAILABLE')
})

function packageFixture() {
  const exports = {
    '.': { types: './lib/backend_index.d.ts', default: './lib/backend_index.js' },
    './api': { types: './lib/shared/public_api.d.ts', default: './lib/shared/public_api.js' },
    './slots': { types: './lib/frontend/public_slots.d.ts', default: './lib/frontend/public_slots.js' },
    './client': './lib/client.js', './typert': './lib/backend/typert.host.js', './remote': './lib/frontend/typert.remote-client.js', './package.json': './package.json',
    './locale/en.json': './bundles/locale/en.json', './locale/zh.json': './bundles/locale/zh.json',
  }
  const manifest = { name: PACKAGE_NAME, version: '0.3.0', type: 'module', main: './lib/backend_index.js', types: './lib/backend_index.d.ts', icon: './icon.svg', exports, dsh: { bundle: { patch: './bundles/session-dashboard.patch.yml' } } }
  const paths = [...new Set(['package.json', ...PUBLIC_DOCUMENTS, ...LOCALE_PATHS, 'icon.svg', 'bundles/session-dashboard.patch.yml', ...Object.values(exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value)).map(value => value.slice(2))])]
  return { manifest, paths }
}
function contractFixture() {
  const descriptor = method => ({ namespace: 'sessionDashboard', method, result: { mode: 'strict' }, parameters: [{ codec: { mode: 'strict' } }] })
  return {
    host: { package: PACKAGE_NAME, invocations: RPC_METHODS.map(descriptor) },
    remote: { package: PACKAGE_NAME, descriptors: RPC_METHODS.map(descriptor) },
    api: { DASHBOARD_API_VERSION: API_VERSION, connectDashboard() {}, publicQuerySchema: { safeParse(value) { return { success: value.apiVersion === API_VERSION } } } },
    slots: { withContributionBoundary() {} },
  }
}

test('package allowlist requires both user READMEs and exported bilingual metadata', () => {
  const { manifest, paths } = packageFixture()
  assert.equal(assertPackageFiles(manifest, paths).size, paths.length)
  for (const path of ['README.en.md', ...LOCALE_PATHS]) assert.throws(() => assertPackageFiles(manifest, paths.filter(value => value !== path)), /Missing/)
  const missingExport = structuredClone(manifest); delete missingExport.exports['./locale/zh.json']
  assert.throws(() => assertPackageFiles(missingExport, paths), /public zh metadata export/)
})

test('package allowlist rejects private implementation, dependencies, reports and unknown bundle files', () => {
  const { manifest, paths } = packageFixture()
  for (const path of ['src/backend_index.ts', 'test/native.test.mjs', 'lib/backend_index.ts', 'node_modules/react/index.js', 'artifacts/result.json', 'docs/PRODUCT-DESIGN.md', 'docs/TECH-DESIGN.md', 'build.mjs', 'bundles/unlisted.json', 'lib/../private.js']) {
    assert.throws(() => assertPackageFiles(manifest, [...paths, path]), /Unexpected|Unsafe/)
  }
  assert.throws(() => assertPackageFiles(manifest, [...paths, paths[0]]), /Duplicate/)
})

test('package contract requires API2 and all ten strict host/client RPC descriptors', () => {
  const { manifest } = packageFixture(), value = contractFixture()
  assertPublicContract(manifest, value.host, value.remote, value.api, value.slots)
  for (const method of ['inspectSession', 'history', 'transcript']) {
    const host = { ...value.host, invocations: value.host.invocations.filter(item => item.method !== method) }
    assert.throws(() => assertPublicContract(manifest, host, value.remote, value.api, value.slots))
  }
  assert.throws(() => assertPublicContract(manifest, value.host, value.remote, { ...value.api, DASHBOARD_API_VERSION: 1 }, value.slots))
  assert.throws(() => assertPublicContract(manifest, value.host, { ...value.remote, descriptors: value.remote.descriptors.slice(1) }, value.api, value.slots))
  const loose = structuredClone(value.host); loose.invocations[0].result.mode = 'loose'
  assert.throws(() => assertPublicContract(manifest, loose, value.remote, value.api, value.slots))
})

test('package contract rejects an API2 label that still accepts API1 queries', () => {
  const { manifest } = packageFixture(), value = contractFixture()
  const api = { ...value.api, publicQuerySchema: { safeParse() { return { success: true } } } }
  assert.throws(() => assertPublicContract(manifest, value.host, value.remote, api, value.slots), /API1/)
})

test('public app-boot metadata reader consumes exact exported zh/en resources and the SVG', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-package-meta-')), owner = join(directory, 'node_modules/@hsx/dsh-session-dashboard')
  await mkdir(join(owner, 'bundles/locale'), { recursive: true })
  const { manifest } = packageFixture()
  await writeFile(join(owner, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(owner, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>')
  const locales = { en: { meta: { title: 'Session Dashboard', description: 'Project-centred session review' } }, zh: { meta: { title: '会话仪表板', description: '按项目查看会话与人工验收' } } }
  for (const language of ['en', 'zh']) await writeFile(join(owner, `bundles/locale/${language}.json`), JSON.stringify(locales[language]))
  const metadata = readPluginMeta(PACKAGE_NAME, pathToFileURL(join(directory, 'consumer.mjs')).href)
  assertLocalizedMetadata(metadata, locales)
  assert.throws(() => assertLocalizedMetadata({ ...metadata, error: 'unreadable resource' }, locales), /unreadable/)
  assert.throws(() => assertLocalizedMetadata({ ...metadata, title: { en: locales.en.meta.title } }, locales), /zh/)
})

test('clean snapshot automatically includes new documentation, locales and behavioral tests without inherited artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-clean-snapshot-')), source = join(directory, 'source'), destination = join(directory, 'snapshot')
  await mkdir(source)
  for (const path of ['README.md', 'README.en.md', 'bundles/locale/en.json', 'bundles/locale/zh.json', 'test/browser/native-sidebar.test.mjs', 'test/product-acceptance.test.mjs', 'package-lock.json', 'lib/stale.js', 'node_modules/unwanted.js', 'artifacts/old.json']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), path)
  }
  const fingerprint = await sourceFingerprint(source), snapshot = await snapshotProject(source, destination)
  assert.equal(snapshot.sha256, fingerprint.sha256)
  for (const path of ['README.en.md', ...LOCALE_PATHS, 'test/browser/native-sidebar.test.mjs', 'test/product-acceptance.test.mjs', 'package-lock.json']) assert.equal(await readFile(join(destination, path), 'utf8'), path)
  for (const path of ['lib/stale.js', 'node_modules/unwanted.js', 'artifacts/old.json']) await assert.rejects(readFile(join(destination, path)), error => error.code === 'ENOENT')
  await writeFile(join(source, 'README.en.md'), 'later edit')
  assert.notEqual((await sourceFingerprint(source)).sha256, snapshot.sha256)
  assert.equal((await sourceFingerprint(destination)).sha256, snapshot.sha256)
})
