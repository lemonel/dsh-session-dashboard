import { agentsExtension } from './agents.js'
import { todosExtension } from './todos.js'
import {
  mountExtension, mounted,
  type ExtensionManifest, type ExtensionModule, type Feature, type HostSources, type MountFailure, type MountedExtension,
} from './contract.js'

/** The extensions this build ships. Later phases add externally loaded modules to
 *  the same list; the dashboard never special-cases a built-in one. */
export const BUILTIN_EXTENSIONS: readonly ExtensionModule[] = [agentsExtension, todosExtension]

/** What this particular dashboard instance can grant: the facet slot is always
 *  there, the catalogue and the todo projection only when a catalogue source
 *  exists, and `session.open.v1` only when a navigation callback was supplied. */
export function availableFeatures(sources: HostSources): Set<Feature> {
  const available = new Set<Feature>(['card.facet.v1'])
  if (sources.catalog !== undefined) {
    available.add('session.catalog.read')
    available.add('session.todos.read')
  }
  if (sources.open !== undefined) available.add('session.open.v1')
  return available
}

export interface ExtensionSet {
  mounted: readonly MountedExtension[]
  failures: readonly MountFailure[]
  /** Built-ins the Host's state file has switched off: not mounted, still listed
   *  in the manager so they can be turned back on. */
  skipped: readonly ExtensionManifest[]
}

/** Mount the shipped extensions against one host. A failure is a reportable row,
 *  never a dashboard outage: the other extensions keep working. An id the Host
 *  reports as disabled is skipped rather than mounted — built-ins are extensions
 *  like any other, so they can be switched off too. */
export function mountBuiltins(sources: HostSources, disabled: ReadonlySet<string> = new Set()): ExtensionSet {
  const available = availableFeatures(sources)
  const skipped = BUILTIN_EXTENSIONS.map(module => module.manifest).filter(manifest => disabled.has(manifest.id))
  const results = BUILTIN_EXTENSIONS.filter(module => !disabled.has(module.manifest.id)).map(module => mountExtension(module, available, sources))
  return { mounted: results.filter(mounted), failures: results.filter(result => !mounted(result)) as MountFailure[], skipped }
}

export { agentsExtension, todosExtension }
export { mountExtension, mounted, createHost, FEATURES, isFeature } from './contract.js'
export type {
  CatalogRow, ExtensionHost, ExtensionManifest, ExtensionModule, FacetSpec, Feature, HostSession, HostSources, HostTodo,
  MountFailure, MountReason, MountedExtension,
} from './contract.js'
