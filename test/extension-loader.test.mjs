import test from 'node:test'
import assert from 'node:assert/strict'
import { importExtensions, loadExtensions, mountImported } from '../lib/frontend/extension-loader.js'
import { FEATURES } from '../lib/shared/extensions/contract.js'

const ALL = new Set(FEATURES)
const sources = { translate: key => key }
const entry = (id, extra = {}) => ({ id, name: id, version: null, description: null, requires: [], optional: [], enabled: true, ok: true, problem: null, ...extra })

/** A fake Host: the list endpoint plus a module loader that records what it was asked for. */
function host({ entries = [], listStatus = 200, listBody, failFetch = false, modules = {} } = {}) {
  const imported = []
  const fetches = []
  return {
    imported,
    fetches,
    deps: {
      fetch: async url => {
        fetches.push(url)
        if (failFetch) throw new Error('offline')
        return new Response(JSON.stringify(listBody ?? { directory: '/ext', entries }), { status: listStatus, headers: { 'content-type': 'application/json' } })
      },
      importModule: async url => {
        imported.push(url)
        const id = new URL(url, 'http://x/').searchParams.get('id')
        const factory = modules[id]
        if (factory === undefined) throw new Error(`no module ${String(id)}`)
        return factory()
      },
    },
  }
}

test('an empty list mounts nothing and reports the directory', async () => {
  const fake = host()
  const load = await loadExtensions(sources, ALL, 0, { deps: fake.deps })
  assert.deepEqual(load.entries, [])
  assert.deepEqual(load.mounted, [])
  assert.deepEqual(load.failures, [])
  assert.equal(load.directory, '/ext')
  assert.equal(load.error, null)
  assert.equal(load.errorKind, null)
  assert.deepEqual([...load.available], [...ALL], 'the granted set is reported for the manager')
  assert.deepEqual(load.disabled, [], 'nothing is switched off by default')
  assert.equal(fake.imported.length, 0)
})

test('importing is separate from mounting: a board update never re-reads or re-imports', async () => {
  const fake = host({ entries: [entry('acme.todo', { requires: ['card.facet.v1'] })], modules: { 'acme.todo': () => ({ default: { facets: () => [{ id: 'todo', chip: () => ({ count: 1 }) }] } }) } })
  const imported = await importExtensions(3, { deps: fake.deps })
  assert.equal(fake.fetches.length, 1)
  assert.equal(imported.modules.length, 1, 'the module is held, not mounted yet')
  assert.deepEqual(imported.failures, [])
  const first = mountImported(imported.modules, sources, ALL)
  const second = mountImported(imported.modules, { ...sources }, ALL)
  assert.equal(first.mounted.length, 1)
  assert.equal(second.mounted.length, 1)
  assert.equal(fake.fetches.length, 1, 'mounting never touches the directory')
  assert.equal(fake.imported.length, 1, 'mounting never re-imports the module')
  const denied = mountImported(imported.modules, sources, new Set(['session.todos.read']))
  assert.deepEqual(denied.failures.map(failure => [failure.id, failure.reason]), [['acme.todo', 'unsupported']], 'the gate is re-evaluated on every mount')
})

test('the list reports every disabled id, built-ins included', async () => {
  const fake = host({ listBody: { directory: '/ext', entries: [], disabled: ['builtin.agents', 'acme.todo'] } })
  const load = await loadExtensions(sources, ALL, 0, { deps: fake.deps })
  assert.deepEqual(load.disabled, ['builtin.agents', 'acme.todo'], 'the browser gets the whole off-list in one round trip')
  const malformed = host({ listBody: { directory: '/ext', entries: [], disabled: ['ok.ext', 7, null] } })
  assert.deepEqual((await loadExtensions(sources, ALL, 0, { deps: malformed.deps })).disabled, ['ok.ext'], 'non-strings are dropped rather than trusted')
})

test('an enabled extension is imported and mounted with its Host manifest', async () => {
  const fake = host({
    entries: [entry('acme.todo', { name: '待办', version: '1.0.0', requires: ['card.facet.v1'] })],
    modules: { 'acme.todo': () => ({ default: { facets: host => [{ id: 'todo', chip: () => host.capabilities.has('card.facet.v1') ? { count: 1 } : null }] } }) },
  })
  const load = await loadExtensions(sources, ALL, 7, { deps: fake.deps })
  assert.equal(load.mounted.length, 1)
  assert.equal(load.mounted[0].manifest.id, 'acme.todo')
  assert.equal(load.mounted[0].manifest.version, '1.0.0')
  assert.equal(load.mounted[0].facets[0].chip({}).count, 1, 'the module only got the capability it declared')
  assert.match(fake.imported[0], /id=acme\.todo&r=7$/, 'the revision is the cache buster')
  // A relative specifier in a dynamic import is a bare specifier: the loader must
  // resolve it against the document or the browser refuses to load the module.
  assert.match(fake.imported[0], /^https?:\/\//, 'the module URL is absolute')
  assert.ok(fake.fetches.every(url => /^https?:\/\//.test(url)), 'the list request is absolute too')
})

test('a disabled or unusable entry is not imported', async () => {
  const fake = host({ entries: [entry('off.ext', { enabled: false }), entry('broken.ext', { ok: false, problem: 'index.js is missing' })] })
  const load = await loadExtensions(sources, ALL, 0, { deps: fake.deps })
  assert.equal(fake.imported.length, 0)
  assert.equal(load.mounted.length, 0)
  assert.deepEqual(load.failures.map(failure => [failure.id, failure.reason]), [['broken.ext', 'invalid']])
  assert.match(load.failures[0].detail, /index\.js is missing/)
})

test('an import error, an unsupported requirement and a malformed module each become rows', async () => {
  const fake = host({
    entries: [entry('throws.ext'), entry('needy.ext', { requires: ['session.todos.read'] }), entry('weird.ext')],
    modules: {
      'needy.ext': () => ({ default: { facets: () => [] } }),
      'weird.ext': () => ({ default: { facets: 'not a function' } }),
    },
  })
  // This host grants the facet slot but no todo projection.
  const load = await loadExtensions(sources, new Set(['card.facet.v1']), 0, { deps: fake.deps })
  assert.deepEqual(load.mounted, [])
  const byId = Object.fromEntries(load.failures.map(failure => [failure.id, failure]))
  assert.equal(byId['throws.ext'].reason, 'failed')
  assert.match(byId['throws.ext'].detail, /import failed: no module throws\.ext/)
  assert.equal(byId['needy.ext'].reason, 'unsupported')
  assert.deepEqual(byId['needy.ext'].missing, ['session.todos.read'])
  assert.equal(byId['weird.ext'].reason, 'invalid')
  assert.match(byId['weird.ext'].detail, /facets\(\)/)
})

test('a module that exports no facets still mounts (it may be menu-only later)', async () => {
  const fake = host({ entries: [entry('silent.ext')], modules: { 'silent.ext': () => ({ default: {} }) } })
  const load = await loadExtensions(sources, ALL, 0, { deps: fake.deps })
  assert.equal(load.mounted.length, 1)
  assert.deepEqual(load.mounted[0].facets, [])
})

test('a list failure is reported without throwing and without importing', async () => {
  const down = host({ failFetch: true })
  const offline = await loadExtensions(sources, ALL, 0, { deps: down.deps })
  assert.equal(offline.error, 'offline')
  assert.deepEqual(offline.mounted, [])

  const notFound = host({ listStatus: 404 })
  const missing = await loadExtensions(sources, ALL, 0, { deps: notFound.deps })
  assert.equal(missing.error, 'unavailable', 'a Host without routes is reported as such, not as a generic failure')
  assert.equal(missing.errorKind, 'unavailable')
  assert.deepEqual(missing.entries, [])

  const broken = host({ listStatus: 500 })
  const failed = await loadExtensions(sources, ALL, 0, { deps: broken.deps })
  assert.equal(failed.error, 'extension list failed: HTTP 500')
  assert.equal(failed.errorKind, 'failed')
})

test('an aborted load resolves quietly instead of reporting an error', async () => {
  const controller = new AbortController()
  controller.abort()
  const fake = host()
  const load = await loadExtensions(sources, ALL, 0, { deps: { fetch: async () => { throw new Error('aborted'); } }, signal: controller.signal })
  assert.equal(load.error, null)
  assert.deepEqual(load.entries, [])
})
