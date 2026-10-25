import assert from 'node:assert/strict'

// The release smoke must reject an accidentally stale, incomplete or private API.
export const PACKAGE_NAME = '@hsx/dsh-session-dashboard'
export const API_VERSION = 2
export const RPC_METHODS = ['candidates', 'extensionEvents', 'extensionSnapshot', 'handshake', 'history', 'inspectSession', 'mutate', 'navigation', 'snapshot', 'transcript']
export const PUBLIC_DOCUMENTS = ['README.md', 'README.en.md', 'docs/EXTENSION-API.md', 'docs/EXTENSIONS.md', 'LICENSE']
export const LOCALE_PATHS = ['bundles/locale/en.json', 'bundles/locale/zh.json']
const rootFiles = new Set(['package.json', ...PUBLIC_DOCUMENTS, 'icon.svg'])

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Exports must name concrete package files')
  return Object.values(value).flatMap(exportTargets)
}

export function assertPackageFiles(manifest, paths) {
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.equal(manifest.type, 'module')
  const packed = new Set(paths)
  assert.equal(packed.size, paths.length, 'Duplicate package entries')
  for (const path of paths) {
    assert(rootFiles.has(path) || /^lib\/.+\.(js|d\.ts)$/.test(path) || path === 'bundles/session-dashboard.patch.yml' || LOCALE_PATHS.includes(path), `Unexpected published file ${path}`)
    assert(!path.split('/').some(segment => segment === '.' || segment === '..' || segment === ''), `Unsafe package path ${path}`)
  }
  for (const path of ['package.json', ...PUBLIC_DOCUMENTS, ...LOCALE_PATHS, 'icon.svg']) assert(packed.has(path), `Missing user resource ${path}`)
  for (const language of ['en', 'zh']) assert.equal(manifest.exports?.[`./locale/${language}.json`], `./bundles/locale/${language}.json`, `Missing public ${language} metadata export`)
  for (const target of [manifest.main, manifest.types, manifest.icon, manifest.dsh?.bundle?.patch, ...exportTargets(manifest.exports)]) {
    assert(typeof target === 'string' && target.startsWith('./'), `Public target must be a relative file: ${target}`)
    assert(packed.has(target.slice(2)), `Missing export ${target}`)
  }
  return packed
}

export function assertPublicContract(manifest, hostDescriptor, remoteDescriptor, api, slots) {
  assert.equal(hostDescriptor.package, manifest.name)
  assert.equal(remoteDescriptor.package, manifest.name)
  assert.deepEqual(hostDescriptor.invocations.map(value => value.method).sort(), RPC_METHODS)
  assert.deepEqual(remoteDescriptor.descriptors.map(value => value.method).sort(), RPC_METHODS)
  for (const descriptor of hostDescriptor.invocations) {
    assert.equal(descriptor.namespace, 'sessionDashboard')
    assert.equal(descriptor.result.mode, 'strict')
    for (const parameter of descriptor.parameters) assert.equal(parameter.codec.mode, 'strict')
  }
  assert.equal(api.DASHBOARD_API_VERSION, API_VERSION)
  assert.equal(typeof api.connectDashboard, 'function')
  assert.equal(typeof slots.withContributionBoundary, 'function')
  assert.equal(api.publicQuerySchema.safeParse({ apiVersion: 1 }).success, false, 'API1 must not be silently served')
  assert.equal(api.publicQuerySchema.safeParse({ apiVersion: API_VERSION }).success, true)
}

export function assertLocalizedMetadata(metadata, locales) {
  assert(metadata && !metadata.error, metadata?.error ?? 'Host could not read plugin metadata')
  for (const language of ['en', 'zh']) {
    const fields = locales[language]?.meta
    for (const field of ['title', 'description']) {
      assert(typeof fields?.[field] === 'string' && fields[field].trim().length > 0, `Missing ${language} meta.${field}`)
      assert.equal(metadata[field]?.[language], fields[field], `Host did not consume ${language} meta.${field}`)
    }
  }
  assert.match(metadata.icon, /^data:image\/svg\+xml;base64,/, 'Host must resolve the packaged SVG icon')
}
