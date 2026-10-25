import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionRegistry, readManifest } from '../lib/backend/extensions-store.js'
import { registerExtensionRoutes, EXTENSIONS_PATH, EXTENSION_MODULE_PATH, EXTENSION_ENABLED_PATH } from '../lib/backend/extensions-routes.js'

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'sd-ext-'))
  return { directory, extensions: join(directory, 'extensions'), cleanup: () => rm(directory, { recursive: true, force: true }) }
}
async function extension(root, id, manifest, source = 'export default { facets: () => [] }\n') {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'extension.json'), JSON.stringify({ id, name: id, ...manifest }, null, 2))
  await writeFile(join(dir, 'index.js'), source)
}

test('a missing extensions directory lists nothing instead of failing', async () => {
  const workspaceRoot = await workspace()
  try {
    assert.deepEqual(await new ExtensionRegistry(workspaceRoot.directory).list(), [])
  } finally { await workspaceRoot.cleanup() }
})

test('a valid extension is listed, enabled by default and served', async () => {
  const root = await workspace()
  try {
    await extension(root.extensions, 'acme.todo', { requires: ['card.facet.v1'], optional: ['session.todos.read'], version: '1.2.3', description: '示例' })
    const registry = new ExtensionRegistry(root.directory)
    const entries = await registry.list()
    assert.equal(entries.length, 1)
    assert.deepEqual({ ...entries[0] }, {
      id: 'acme.todo', name: 'acme.todo', version: '1.2.3', description: '示例',
      requires: ['card.facet.v1'], optional: ['session.todos.read'], enabled: true, ok: true, problem: null,
    })
    const module = await registry.readModule('acme.todo')
    assert.match(module.source, /export default/)
  } finally { await root.cleanup() }
})

test('a malformed manifest stays visible with its reason', async () => {
  const root = await workspace()
  try {
    await mkdir(join(root.extensions, 'broken'), { recursive: true })
    await writeFile(join(root.extensions, 'broken', 'extension.json'), '{ not json')
    await extension(root.extensions, 'unknown.cap', { requires: ['card.facet.v9'] })
    await mkdir(join(root.extensions, 'no-module'), { recursive: true })
    await writeFile(join(root.extensions, 'no-module', 'extension.json'), JSON.stringify({ id: 'no-module', name: 'x', requires: [] }))
    const entries = await new ExtensionRegistry(root.directory).list()
    const broken = entries.find(entry => entry.id === 'broken')
    assert.equal(broken.ok, false)
    assert.match(broken.problem, /cannot read extension.json/)
    const unknown = entries.find(entry => entry.id === 'unknown.cap')
    assert.equal(unknown.ok, false)
    assert.match(unknown.problem, /unknown capability: card\.facet\.v9/)
    const noModule = entries.find(entry => entry.id === 'no-module')
    assert.equal(noModule.ok, false)
    assert.match(noModule.problem, /index\.js is missing/)
  } finally { await root.cleanup() }
})

test('disabling an extension persists and stops serving its module', async () => {
  const root = await workspace()
  try {
    await extension(root.extensions, 'acme.todo', { requires: ['card.facet.v1'] })
    const registry = new ExtensionRegistry(root.directory)
    const afterDisable = await registry.setEnabled('acme.todo', false)
    assert.equal(afterDisable.find(entry => entry.id === 'acme.todo').enabled, false)
    const reopened = await new ExtensionRegistry(root.directory).list()
    assert.equal(reopened.find(entry => entry.id === 'acme.todo').enabled, false, 'the state file is the source of truth')
    const module = await registry.readModule('acme.todo')
    assert.match(module.problem, /disabled/)
    const afterEnable = await registry.setEnabled('acme.todo', true)
    assert.equal(afterEnable.find(entry => entry.id === 'acme.todo').enabled, true)
  } finally { await root.cleanup() }
})

test('a built-in id is a known id even without a directory', async () => {
  const root = await workspace()
  try {
    const registry = new ExtensionRegistry(root.directory, ['builtin.agents', 'builtin.todos'])
    const afterDisable = await registry.setEnabled('builtin.agents', false)
    assert.equal(afterDisable.length, 0, 'a built-in has no directory row to report')
    assert.deepEqual(await registry.disabled(), ['builtin.agents'])
    const reopened = new ExtensionRegistry(root.directory, ['builtin.agents', 'builtin.todos'])
    assert.deepEqual(await reopened.disabled(), ['builtin.agents'], 'the same state file governs both kinds')
    await reopened.setEnabled('builtin.agents', true)
    assert.deepEqual(await reopened.disabled(), [])
    assert.match((await reopened.readModule('builtin.agents')).problem, /unknown extension/, 'a built-in still has no module to serve')
  } finally { await root.cleanup() }
})

test('an unknown id is refused instead of invented', async () => {
  const root = await workspace()
  try {
    const registry = new ExtensionRegistry(root.directory)
    await assert.rejects(() => registry.setEnabled('nope', false), /unknown extension/)
    assert.match((await registry.readModule('nope')).problem, /unknown extension/)
    assert.match((await registry.readModule('../etc')).problem, /unknown extension/)
  } finally { await root.cleanup() }
})

test('the manifest reader validates identity and capabilities without throwing', () => {
  assert.match(readManifest({ id: 'Bad Id', name: 'x', requires: [] }).problem, /id must be/)
  assert.match(readManifest({ id: 'ok', name: 'x', requires: 'nope' }).problem, /requires must be an array/)
  assert.match(readManifest({ id: 'ok', name: 'x', requires: ['nope.v1'] }).problem, /unknown capability/)
  const parsed = readManifest({ id: 'ok', name: '  ', requires: ['card.facet.v1'] })
  assert.equal(parsed.manifest.name, 'ok', 'a blank name falls back to the identity')
  assert.deepEqual(parsed.manifest.requires, ['card.facet.v1'])
})

/** A Host that composes no Web carrier: route registration must be a no-op. */
function routes() {
  const registered = new Map()
  registerExtensionRoutes({ get: () => undefined }, null)
  return registered
}

test('the routes serve the list, one module and the enable switch', async () => {
  const root = await workspace()
  try {
    await extension(root.extensions, 'acme.todo', { requires: ['card.facet.v1'] })
    const registry = new ExtensionRegistry(root.directory, ['builtin.agents'])
    const registered = new Map()
    const ctx = { get: name => name === 'connection' ? { fetch: { register: route => registered.set(route.path, route) } } : undefined }
    registerExtensionRoutes(ctx, registry)
    assert.deepEqual([...registered.keys()].sort(), [EXTENSIONS_PATH, EXTENSION_MODULE_PATH, EXTENSION_ENABLED_PATH].sort())

    const list = await registered.get(EXTENSIONS_PATH).fetch(new Request(`http://x${EXTENSIONS_PATH}`))
    assert.equal(list.status, 200)
    const listed = await list.json()
    assert.equal(listed.entries[0].id, 'acme.todo')
    assert.deepEqual(listed.disabled, [], 'the off-list rides along with the entries')
    assert.equal(list.headers.get('cache-control'), 'no-store')

    const module = await registered.get(EXTENSION_MODULE_PATH).fetch(new Request(`http://x${EXTENSION_MODULE_PATH}?id=acme.todo`))
    assert.equal(module.status, 200)
    assert.match(module.headers.get('content-type'), /text\/javascript/)
    assert.match(await module.text(), /export default/)

    const missingId = await registered.get(EXTENSION_MODULE_PATH).fetch(new Request(`http://x${EXTENSION_MODULE_PATH}`))
    assert.equal(missingId.status, 400)
    const unknown = await registered.get(EXTENSION_MODULE_PATH).fetch(new Request(`http://x${EXTENSION_MODULE_PATH}?id=nope`))
    assert.equal(unknown.status, 404)

    const toggled = await registered.get(EXTENSION_ENABLED_PATH).fetch(new Request(`http://x${EXTENSION_ENABLED_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'acme.todo', enabled: false }),
    }))
    assert.equal(toggled.status, 200)
    const toggledBody = await toggled.json()
    assert.equal(toggledBody.entries[0].enabled, false)
    assert.deepEqual(toggledBody.disabled, ['acme.todo'], 'the write returns the new off-list so the page needs no second read')

    const builtinOff = await registered.get(EXTENSION_ENABLED_PATH).fetch(new Request(`http://x${EXTENSION_ENABLED_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'builtin.agents', enabled: false }),
    }))
    assert.equal(builtinOff.status, 200, 'a built-in id is a known id')
    assert.deepEqual((await builtinOff.json()).disabled.sort(), ['acme.todo', 'builtin.agents'])
    const relisted = await (await registered.get(EXTENSIONS_PATH).fetch(new Request(`http://x${EXTENSIONS_PATH}`))).json()
    assert.deepEqual(relisted.disabled.sort(), ['acme.todo', 'builtin.agents'])

    const badBody = await registered.get(EXTENSION_ENABLED_PATH).fetch(new Request(`http://x${EXTENSION_ENABLED_PATH}`, { method: 'POST', body: 'nope' }))
    assert.equal(badBody.status, 400)
    const badShape = await registered.get(EXTENSION_ENABLED_PATH).fetch(new Request(`http://x${EXTENSION_ENABLED_PATH}`, { method: 'POST', body: JSON.stringify({ id: 'acme.todo' }) }))
    assert.equal(badShape.status, 400)
    const unknownToggle = await registered.get(EXTENSION_ENABLED_PATH).fetch(new Request(`http://x${EXTENSION_ENABLED_PATH}`, { method: 'POST', body: JSON.stringify({ id: 'nope', enabled: true }) }))
    assert.equal(unknownToggle.status, 404)
  } finally { await root.cleanup() }
})

test('a host without the Web carrier gets no routes and no crash', () => {
  const registered = routes()
  assert.equal(registered.size, 0)
})
