/** Capability-first extension contract.
 *
 *  An extension never receives "the dashboard" or "the DSH context": it declares
 *  which capabilities it needs, and the host hands back an object that contains
 *  exactly those namespaces and nothing else. An undeclared namespace is not
 *  denied at call time — it is absent, so the plugin fails immediately and
 *  visibly instead of silently reading `undefined`.
 *
 *  Compatibility therefore rides on capability ids (`…​.v1`), never on a version
 *  number: a plugin that needs `session.todos.read` keeps working as long as the
 *  host can still supply that capability, no matter which DSH ships underneath.
 *
 *  This module is React-free and dependency-free on purpose: the same contract is
 *  used by the dashboard's own built-in extensions, by extension tests, and later
 *  by externally loaded extension bundles. */

import type { FacetChip, FacetRow } from '../facets.js'

/** Every capability this dashboard can grant. The suffix is the contract major:
 *  a breaking change to a payload or a behaviour ships `…​.v2` beside the old id. */
export const FEATURES = [
  /** A row facet: chip plus an optional popover of rows. */
  'card.facet.v1',
  /** Read the Session catalogue: titles, parentage, running state. */
  'session.catalog.read',
  /** Read one Session's current-turn todo projection. */
  'session.todos.read',
  /** Ask the native client to open a Session. */
  'session.open.v1',
] as const
export type Feature = (typeof FEATURES)[number]

const FEATURE_SET: ReadonlySet<string> = new Set(FEATURES)
export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && FEATURE_SET.has(value)
}

/** One extension's identity and its declarations.
 *
 *  `requires` is a hard gate: if any entry is unavailable the extension does not
 *  mount at all. `optional` capabilities are granted when the host has them, and
 *  the extension must feature-detect (`host.todos?.read`) because they can be
 *  absent — that is how a facet can enrich itself without hard-depending. */
export interface ExtensionManifest {
  /** Stable identity, `vendor.name` style; used for React keys and management. */
  id: string
  name: string
  version?: string
  requires: readonly Feature[]
  optional?: readonly Feature[]
}

/** The Session as an extension sees it: identity plus the Host facts the row
 *  already carries. Extensions never receive the raw card. */
export interface HostSession {
  sessionId: string
  title: string
  projectId: string | null
  /** Live child agents under this Session, from the Host's own runtime fact. */
  activeAgents: number
}

/** One catalogue row reduced to what extensions may read. */
export interface CatalogRow {
  id: string
  title: string
  parentId: string | null
  running: boolean
  updatedAt: number
  projectionValues?: Readonly<Record<string, unknown>>
}

/** One todo of the current turn, as the `todos` projection publishes it. */
export interface HostTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** What the dashboard can supply. Every namespace is optional: a host that cannot
 *  offer one simply does not grant the matching capability. */
export interface HostSources {
  translate(key: string, params?: Record<string, unknown>): string
  /** Raw catalogue snapshot; the contract derives session/children/todos from it. */
  catalog?: { getSnapshot(): { byId: Readonly<Record<string, CatalogRow | undefined>> } }
  open?(sessionId: string): void
}

/** The object handed to an extension. Only granted namespaces exist at all. */
export interface ExtensionHost {
  readonly capabilities: ReadonlySet<Feature>
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly catalog?: {
    session(id: string): CatalogRow | null
    children(id: string): readonly CatalogRow[]
  }
  readonly todos?: { read(id: string): readonly HostTodo[] | null }
  readonly open?: (sessionId: string) => void
}

/** One facet an extension contributes: a chip plus an optional popover body.
 *  Descriptors are data, so the dashboard owns every pixel and every popover. */
export interface FacetSpec {
  /** Stable inside its extension. */
  id: string
  /** `null` hides the facet entirely for this Session (0/0 must not render). */
  chip: (session: HostSession) => FacetChip | null
  /** Popover rows, read only when the reader opens the panel. */
  rows?: (session: HostSession) => readonly FacetRow[] | Promise<readonly FacetRow[]>
  /** Shown instead of an empty list. */
  empty?: string
}

/** The module an extension author writes. */
export interface ExtensionModule {
  manifest: ExtensionManifest
  facets?(host: ExtensionHost): readonly FacetSpec[]
}

/** A mounted extension: its manifest plus the descriptors it produced. */
export interface MountedExtension {
  manifest: ExtensionManifest
  facets: readonly FacetSpec[]
}

export type MountReason = 'invalid' | 'unsupported' | 'failed'

/** Why an extension is not running, for the management surface. */
export interface MountFailure {
  id: string
  name: string
  reason: MountReason
  detail: string
  missing: readonly Feature[]
}

const IDENTITY = /^[a-z0-9][a-z0-9._-]*$/i
/** A facet id must be usable as a React key and a data attribute. */
const FACET_IDENTITY = /^[a-z0-9][a-z0-9._-]*$/i

function fail(module: ExtensionModule, reason: MountReason, detail: string, missing: readonly Feature[] = []): MountFailure {
  return { id: typeof module?.manifest?.id === 'string' ? module.manifest.id : 'unknown', name: typeof module?.manifest?.name === 'string' ? module.manifest.name : 'unknown', reason, detail, missing }
}

/** Read the todo projection of one catalogue row. Null when the row carries no
 *  usable list; malformed entries are dropped rather than surfacing as `NaN`. */
export function readTodos(row: CatalogRow | undefined): readonly HostTodo[] | null {
  const todos = row?.projectionValues?.todos
  if (!Array.isArray(todos)) return null
  const result: HostTodo[] = []
  for (const entry of todos) {
    if (typeof entry !== 'object' || entry === null) continue
    const { content, status } = entry as { content?: unknown; status?: unknown }
    if (typeof content !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    result.push({ content, status })
  }
  return result
}

/** Child rows of one Session, parents before children, bounded so a pathological
 *  catalogue cannot turn one popover into a full-page dump. */
export function childRows(catalog: HostSources['catalog'], id: string, maxDepth = 4, maxRows = 40): CatalogRow[] {
  if (catalog === undefined) return []
  const byId = catalog.getSnapshot().byId
  const children = new Map<string, CatalogRow[]>()
  for (const row of Object.values(byId)) {
    if (row === undefined || row.parentId === null) continue
    const list = children.get(row.parentId) ?? []
    list.push(row)
    children.set(row.parentId, list)
  }
  const found: CatalogRow[] = []
  const seen = new Set<string>()
  const walk = (parentId: string, depth: number): void => {
    if (depth >= maxDepth) return
    for (const row of children.get(parentId) ?? []) {
      if (seen.has(row.id) || found.length >= maxRows) continue
      seen.add(row.id)
      found.push(row)
      walk(row.id, depth + 1)
    }
  }
  walk(id, 0)
  return found
}

/** Build the host for one manifest: a namespace exists only when the manifest
 *  declared the capability *and* this host can supply it. */
export function createHost(manifest: ExtensionManifest, available: ReadonlySet<Feature>, sources: HostSources): ExtensionHost {
  const granted = new Set<Feature>()
  const declared = [...manifest.requires, ...manifest.optional ?? []]
  for (const feature of declared) if (available.has(feature)) granted.add(feature)
  const host: Mutable<ExtensionHost> = { capabilities: granted, t: sources.translate }
  const catalog = sources.catalog
  if (catalog !== undefined && (granted.has('session.catalog.read') || granted.has('session.todos.read'))) {
    const read = (id: string): CatalogRow | null => catalog.getSnapshot().byId[id] ?? null
    Object.defineProperty(host, 'catalog', { value: Object.freeze({ session: read, children: (id: string) => childRows(catalog, id) }), enumerable: true })
    Object.defineProperty(host, 'todos', { value: Object.freeze({ read: (id: string) => readTodos(read(id) ?? undefined) }), enumerable: true })
  }
  if (sources.open !== undefined && granted.has('session.open.v1')) host.open = sources.open
  return Object.freeze(host)
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Validate, gate and call one extension. Never throws: a broken extension is a
 *  reportable failure, not a dashboard outage. */
export function mountExtension(module: ExtensionModule, available: ReadonlySet<Feature>, sources: HostSources): MountedExtension | MountFailure {
  const manifest = module?.manifest
  if (manifest === undefined || typeof manifest.id !== 'string' || !IDENTITY.test(manifest.id) || typeof manifest.name !== 'string' || manifest.name === '') return fail(module, 'invalid', 'manifest needs an id (letters, digits, dot, dash, underscore) and a name')
  if (!Array.isArray(manifest.requires)) return fail(module, 'invalid', 'manifest.requires must be an array')
  const unknown = manifest.requires.filter(feature => !isFeature(feature))
  if (unknown.length > 0) return fail(module, 'invalid', `unknown capability: ${unknown.join(', ')}`)
  const missing = manifest.requires.filter(feature => !available.has(feature))
  if (missing.length > 0) return fail(module, 'unsupported', `this host does not provide: ${missing.join(', ')}`, missing)
  let facets: readonly FacetSpec[]
  try {
    facets = module.facets === undefined ? [] : module.facets(createHost(manifest, available, sources))
  } catch (error) {
    return fail(module, 'failed', error instanceof Error ? error.message : String(error))
  }
  if (!Array.isArray(facets)) return fail(module, 'failed', 'facets() must return an array')
  for (const spec of facets) {
    if (typeof spec?.id !== 'string' || !FACET_IDENTITY.test(spec.id)) return fail(module, 'invalid', 'every facet needs an id (letters, digits, dot, dash, underscore)')
    if (typeof spec.chip !== 'function') return fail(module, 'invalid', `facet ${spec.id} needs a chip() function`)
  }
  return { manifest, facets }
}

/** True when a mount produced facets (the success arm of {@link MountedExtension}). */
export function mounted(value: MountedExtension | MountFailure): value is MountedExtension {
  return 'facets' in value
}
