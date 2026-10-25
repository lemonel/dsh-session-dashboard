import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import * as ReactJSX from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { assertLocalizedMetadata, assertPackageFiles, assertPublicContract } from './package-contract.mjs'
import { npmExecFileSync } from './process.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const destination = await mkdtemp(join(tmpdir(), 'session-dashboard-package-'))
const result = JSON.parse(npmExecFileSync(['pack', '--json', '--pack-destination', destination], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))[0]
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(result.name, manifest.name); assert.equal(result.version, manifest.version)
const paths = result.files.map(row => row.path).sort(), packed = assertPackageFiles(manifest, paths)
assert(!JSON.stringify(manifest).includes('workspace:'), 'No source-checkout peers')
const lock = await readFile(join(root, 'package-lock.json'), 'utf8')
const locked = JSON.parse(lock)
assert.equal(locked.version, manifest.version, 'Lockfile version must match the package version')
assert.equal(locked.packages?.['']?.version, manifest.version, 'Lockfile root version must match the package version')
assert.deepEqual(manifest.engines?.dsh, manifest.dsh?.engines?.dsh, 'The supported DSH range must be declared once')
assert(!/file:|link:|\/home\/|\/tmp\//.test(lock), 'Portable lockfile required')
const archive = join(destination, result.filename)
execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' })
const extracted = join(destination, 'package')
async function allOutputs(path = 'lib') {
  const values = []
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const next = `${path}/${entry.name}`
    if (entry.isDirectory()) values.push(...await allOutputs(next)); else values.push(next)
  }
  return values
}
for (const path of await allOutputs()) assert(packed.has(path), `Unpacked output missing ${path}`)
for (const path of paths.filter(path => path.endsWith('.js'))) {
  const text = await readFile(join(extracted, path), 'utf8')
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
    const specifier = node.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
    const target = relative(extracted, join(dirname(join(extracted, path)), specifier.text)).replaceAll('\\', '/')
    assert(packed.has(target), `Missing relative module ${path} -> ${target}`)
  }
}
// A missing peer must fail, not resolve an unrelated global/source installation.
const missing = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(extracted, manifest.main)).href)})`], { cwd: extracted, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
assert.notEqual(missing.status, 0, 'Artifact without peers must not silently load a fallback host')
assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/, 'Missing dependency failure must be explicit')
// Packed ESM and compiled descriptors are imported with THIS installation, never global fallback.
await symlink(join(root, 'node_modules'), join(extracted, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const host = await import(pathToFileURL(join(extracted, manifest.main)).href)
assert.equal(host.name, 'session-dashboard'); assert.equal(typeof host.apply, 'function')
const { TYPERT } = await import(pathToFileURL(join(extracted, manifest.exports['./typert'])).href)
const { default: remote } = await import(pathToFileURL(join(extracted, manifest.exports['./remote'])).href)
const api = await import(pathToFileURL(join(extracted, manifest.exports['./api'].default)).href)
const slots = await import(pathToFileURL(join(extracted, manifest.exports['./slots'].default)).href)
assertPublicContract(manifest, TYPERT, remote, api, slots)
// Metadata is read by the selected SDK's public boot API, never by importing
// a private host source path or mutating the active profile resolver.
const metadataProbe = `import {readPluginMeta} from '@deepseek-ai/dsh-app-boot'; console.log(JSON.stringify(readPluginMeta(${JSON.stringify(manifest.name)}, import.meta.url)))`
const metadata = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', metadataProbe], { cwd: extracted, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }))
const locales = Object.fromEntries(await Promise.all(['en', 'zh'].map(async language => [language, JSON.parse(await readFile(join(extracted, `bundles/locale/${language}.json`), 'utf8'))])))
assertLocalizedMetadata(metadata, locales)
let registration
vm.runInNewContext(await readFile(join(extracted, manifest.exports['./client']), 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
assert.equal(registration.id, manifest.name)
const browser = registration.factory(name => { if (name === 'react') return React; if (name === 'react/jsx-runtime') return ReactJSX; if (name === 'react-dom') return ReactDOM; throw new Error(`Unexpected shared runtime ${name}`) })
assert.equal(browser.name, 'session-dashboard/client'); assert.equal(typeof browser.apply, 'function')
console.log(JSON.stringify({ package: result.name, version: result.version, files: paths.length, archive, checks: ['portable lock', 'allowlist', 'zh/en user resources', 'host localized metadata and SVG', 'all outputs', 'all relative imports', 'missing peers fail', 'host import', 'API2 and ten strict RPC methods', 'lazy native client'] }, null, 2))
