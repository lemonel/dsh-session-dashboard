import { mountExtension, mounted, type ExtensionModule, type Feature, type HostSources, type MountFailure, type MountedExtension } from '../shared/extensions/index.js'
import { EXTENSIONS_PATH } from '../shared/extensions/routes.js'

/** One row of the Host's extension list. The Host validates the manifest; the
 *  browser trusts this list for identity and capabilities, never the module. */
export interface ExtensionEntry {
  id: string
  name: string
  version: string | null
  description: string | null
  requires: readonly string[]
  optional: readonly string[]
  enabled: boolean
  ok: boolean
  problem: string | null
}

/** Reading and importing is all network work and depends only on the revision:
 *  the result is reusable across every re-mount this page does. */
export interface ExtensionImport {
  /** Every directory the Host found, including disabled and unusable ones. */
  entries: readonly ExtensionEntry[]
  /** Every id the Host has switched off, built-ins included: the dashboard uses
   *  it to decide which bundled extensions it may mount. */
  disabled: readonly string[]
  directory: string | null
  /** Modules that imported and exposed a usable default export, before mounting.
   *  Mounting is a pure call, so a board update re-mounts these without touching
   *  the network or the import cache. */
  modules: readonly ExtensionModule[]
  /** Entries that never became a module: unusable manifest, import error, bad export. */
  failures: readonly MountFailure[]
  /** Set when the list itself could not be read. `unavailable` means the Host
   *  registered no extension routes at all — a Host older than this feature, which
   *  only a restart fixes; `failed` is anything else and carries the reason. */
  error: string | null
  errorKind: 'unavailable' | 'failed' | null
}

/** What the page mounts: the import plus the capability-gated results. */
export interface ExtensionLoad extends ExtensionImport {
  mounted: readonly MountedExtension[]
  /** Capabilities this dashboard instance currently grants, in FEATURES order.
   *  The manager shows them so "missing capability" has a visible counterpart. */
  available: readonly Feature[]
}

export interface LoaderDeps {
  fetch?: typeof fetch
  importModule?: (url: string) => Promise<{ default?: unknown }>
  base?: string
}

const BASE = EXTENSIONS_PATH

/** Resolve one route against the document, not the module: a relative specifier
 *  in a dynamic `import()` is read as a *bare* specifier and fails to resolve, so
 *  the module URL must be absolute even though `fetch()` accepts the relative
 *  form. `location.href` also keeps a mounted-under-a-path deployment working. */
function absolute(path: string): string {
  const base = typeof location === 'undefined' ? 'http://dsh.invalid/' : location.href
  try { return new URL(path, base).href } catch { return path }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRoutes(value: unknown): ExtensionEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  const strings = (list: unknown): readonly string[] => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  return {
    id: record.id,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : record.id,
    version: typeof record.version === 'string' ? record.version : null,
    description: typeof record.description === 'string' ? record.description : null,
    requires: strings(record.requires),
    optional: strings(record.optional),
    enabled: record.enabled === true,
    ok: record.ok === true,
    problem: typeof record.problem === 'string' ? record.problem : null,
  }
}

const EMPTY_IMPORT: ExtensionImport = { entries: [], disabled: [], directory: null, modules: [], failures: [], error: null, errorKind: null }

/** Read the Host's list and import every enabled module. Never throws: a broken
 *  extension or a missing route becomes a visible failure while the built-in
 *  facets keep working. The result depends only on `revision`, so the page can
 *  hold it across board updates instead of re-reading the directory. */
export async function importExtensions(
  revision: number,
  options: { deps?: LoaderDeps; signal?: AbortSignal } = {},
): Promise<ExtensionImport> {
  const fetcher = options.deps?.fetch ?? (typeof fetch === 'function' ? fetch : undefined)
  const importModule = options.deps?.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<{ default?: unknown }>)
  const base = options.deps?.base ?? BASE
  if (fetcher === undefined) return { ...EMPTY_IMPORT, error: 'fetch is unavailable', errorKind: 'failed' }
  let entries: ExtensionEntry[] = []
  let directory: string | null = null
  let disabled: string[] = []
  try {
    const response = await fetcher(absolute(base), { cache: 'no-store', ...options.signal === undefined ? {} : { signal: options.signal } })
    if (!response.ok) return {
      ...EMPTY_IMPORT,
      // 404 is the Host saying "no such route": the running process predates the
      // extension routes. A restart installs them; retrying the fetch does not.
      error: response.status === 404 ? 'unavailable' : `extension list failed: HTTP ${String(response.status)}`,
      errorKind: response.status === 404 ? 'unavailable' : 'failed',
    }
    const body: unknown = await response.json()
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    directory = typeof record.directory === 'string' ? record.directory : null
    disabled = Array.isArray(record.disabled) ? record.disabled.filter((item): item is string => typeof item === 'string') : []
    entries = Array.isArray(record.entries) ? record.entries.map(asRoutes).filter((entry): entry is ExtensionEntry => entry !== null) : []
  } catch (error) {
    if (options.signal?.aborted === true) return EMPTY_IMPORT
    return { ...EMPTY_IMPORT, error: reasonOf(error), errorKind: 'failed' }
  }
  const modules: ExtensionModule[] = []
  const failures: MountFailure[] = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    if (!entry.ok) {
      failures.push({ id: entry.id, name: entry.name, reason: 'invalid', detail: entry.problem ?? 'extension is unusable', missing: [] })
      continue
    }
    let implementation: { default?: unknown } | undefined
    try {
      implementation = await importModule(absolute(`${base}/module?id=${encodeURIComponent(entry.id)}&r=${String(revision)}`))
    } catch (error) {
      failures.push({ id: entry.id, name: entry.name, reason: 'failed', detail: `import failed: ${reasonOf(error)}`, missing: [] })
      continue
    }
    const face = implementation?.default
    const facets = typeof face === 'object' && face !== null ? (face as { facets?: unknown }).facets : undefined
    if (facets !== undefined && typeof facets !== 'function') {
      failures.push({ id: entry.id, name: entry.name, reason: 'invalid', detail: 'default export must expose facets()', missing: [] })
      continue
    }
    // The Host's manifest is authoritative: a module cannot grant itself a
    // capability by exporting a different one.
    modules.push({
      manifest: { id: entry.id, name: entry.name, requires: entry.requires as Feature[], optional: entry.optional as Feature[], ...entry.version === null ? {} : { version: entry.version } },
      ...facets === undefined ? {} : { facets: facets as ExtensionModule['facets'] },
    })
  }
  return { entries, disabled, directory, modules, failures, error: null, errorKind: null }
}

/** Mount already-imported modules against one dashboard instance. Pure and cheap:
 *  this is what runs when the board changes, never a fetch or an import. */
export function mountImported(modules: readonly ExtensionModule[], sources: HostSources, available: ReadonlySet<Feature>): { mounted: readonly MountedExtension[]; failures: readonly MountFailure[] } {
  const mountedExtensions: MountedExtension[] = []
  const failures: MountFailure[] = []
  for (const module of modules) {
    const result = mountExtension(module, available, sources)
    if (mounted(result)) mountedExtensions.push(result)
    else failures.push(result)
  }
  return { mounted: mountedExtensions, failures }
}

/** Import and mount in one call: the shape the manager and most tests use. */
export async function loadExtensions(
  sources: HostSources,
  available: ReadonlySet<Feature>,
  revision: number,
  options: { deps?: LoaderDeps; signal?: AbortSignal } = {},
): Promise<ExtensionLoad> {
  const imported = await importExtensions(revision, options)
  const result = mountImported(imported.modules, sources, available)
  return { ...imported, mounted: result.mounted, failures: [...imported.failures, ...result.failures], available: [...available] }
}
