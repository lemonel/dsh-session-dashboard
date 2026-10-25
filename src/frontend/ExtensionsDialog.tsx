import type { ExtensionEntry, ExtensionLoad } from './extension-loader.js'
import { FEATURES, type ExtensionSet, type MountFailure } from '../shared/extensions/index.js'
import { Modal } from './Modal.js'
import { useTranslator, type TranslationKey } from './i18n.js'

/** One extension's runtime state, derived from the Host list plus this page's
 *  mount results. A row is never "unknown": every entry lands in exactly one of
 *  these, so the operator can tell "not loaded" from "loaded but broken". */
type State = 'mounted' | 'disabled' | 'unusable' | 'failed' | 'unsupported'

/** One rendered row, whichever way the extension arrived. Built-ins ship inside
 *  the bundle and directory extensions are loaded from the Host; both fill the
 *  same shape so the manager has one table and one toggle. */
interface Row {
  id: string
  name: string
  version: string | null
  description: string | null
  requires: readonly string[]
  optional: readonly string[]
  state: State
  detail: string | null
  facets: number
  enabled: boolean
  builtin: boolean
}

const CAPABILITY_NOTE: Record<string, TranslationKey> = {
  'card.facet.v1': 'capabilityFacet',
  'session.catalog.read': 'capabilityCatalog',
  'session.todos.read': 'capabilityTodos',
  'session.open.v1': 'capabilityOpen',
}

function describeCapability(id: string, t: (key: TranslationKey) => string): string {
  const note = CAPABILITY_NOTE[id]
  return note === undefined ? t('capabilityUnknown') : t(note)
}

/** Where one entry ended up and why. Failures are matched by id so a mount error
 *  keeps its own detail rather than a generic message. */
function stateOf(entry: ExtensionEntry, failure: MountFailure | undefined): { state: State; detail: string | null; facets: number } {
  if (!entry.enabled) return { state: 'disabled', detail: null, facets: 0 }
  if (!entry.ok) return { state: 'unusable', detail: entry.problem, facets: 0 }
  if (failure !== undefined) return { state: failure.reason === 'unsupported' ? 'unsupported' : 'failed', detail: failure.detail, facets: 0 }
  return { state: 'mounted', detail: null, facets: 0 }
}

/** The extensions this build ships, listed as rows too: they go through the same
 *  contract, the same slot and the same state file, so leaving them out would let
 *  the manager claim the dashboard has one extension and one facet when it has
 *  three. A switched-off built-in is listed rather than dropped, so it can be
 *  turned back on. */
function builtinRows(builtins: ExtensionSet): Row[] {
  const mounted = builtins.mounted.map(extension => ({
    id: extension.manifest.id,
    name: extension.manifest.name,
    version: extension.manifest.version ?? null,
    description: null,
    requires: extension.manifest.requires,
    optional: extension.manifest.optional ?? [],
    state: 'mounted' as State,
    detail: null,
    facets: extension.facets.length,
    enabled: true,
    builtin: true,
  }))
  const skipped = builtins.skipped.map(manifest => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version ?? null,
    description: null,
    requires: manifest.requires,
    optional: manifest.optional ?? [],
    state: 'disabled' as State,
    detail: null,
    facets: 0,
    enabled: false,
    builtin: true,
  }))
  const failed = builtins.failures.map(failure => ({
    id: failure.id,
    name: failure.name,
    version: null,
    description: null,
    requires: [] as readonly string[],
    optional: [] as readonly string[],
    state: (failure.reason === 'unsupported' ? 'unsupported' : 'failed') as State,
    detail: failure.detail,
    facets: 0,
    enabled: true,
    builtin: true,
  }))
  return [...mounted, ...skipped, ...failed]
}

/** The dashboard's own extension manager. Deliberately separate from DSH's plugin
 *  list: these modules are loaded by this plugin, not by the Host loader. */
export function ExtensionsDialog({ load, builtins = { mounted: [], failures: [], skipped: [] }, busy, onToggle, onReload, onClose }: {
  load: ExtensionLoad | null
  /** The extensions compiled into this build, so the list is the whole picture. */
  builtins?: ExtensionSet
  busy: boolean
  onToggle: (id: string, enabled: boolean) => void
  onReload: () => void
  onClose: () => void
}) {
  const t = useTranslator()
  const mountedCount = builtins.mounted.length + (load?.mounted.length ?? 0)
  const facetCount = builtins.mounted.reduce((total, extension) => total + extension.facets.length, 0)
    + (load?.mounted.reduce((total, extension) => total + extension.facets.length, 0) ?? 0)
  const rows: Row[] = [...builtinRows(builtins), ...(load?.entries.map(entry => {
    const failure = load.failures.find(item => item.id === entry.id)
    const state = stateOf(entry, failure)
    const mountedFacets = load.mounted.find(extension => extension.manifest.id === entry.id)?.facets.length ?? 0
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      requires: entry.requires,
      optional: entry.optional,
      ...state,
      facets: mountedFacets,
      enabled: entry.enabled,
      builtin: false,
    }
  }) ?? [])]
  const stateLabel = (state: State): string => t(state === 'mounted' ? 'extensionMounted' : state === 'disabled' ? 'extensionDisabled' : state === 'unusable' ? 'extensionUnusable' : state === 'unsupported' ? 'extensionUnsupported' : 'extensionFailed')

  return <Modal title={t('extensionsTitle')} busy={busy} onClose={onClose}>
    <p className="sd-small sd-muted">{t('extensionsHint')}</p>
    {load?.directory !== null && load?.directory !== undefined && <p className="sd-small sd-muted" data-selectable>{load.directory}</p>}
    {load !== null && <div className="sd-row sd-extcaps" aria-label={t('extensionsGranted')}>
      <span className="sd-small sd-muted">{t('extensionsGranted')}</span>
      {FEATURES.map(feature => <span key={feature} className="sd-extcap" data-granted={load.available.includes(feature) ? 'true' : 'false'} title={describeCapability(feature, t)}>{feature}</span>)}
    </div>}
    {load?.error !== null && load?.error !== undefined && <div className="sd-notice" role="alert">
      <p>{load.errorKind === 'unavailable' ? t('extensionsUnavailable') : t('extensionsListFailed', { reason: load.error })}</p>
      {load.errorKind === 'unavailable' && <p className="sd-small sd-muted">{t('extensionsUnavailableHint')}</p>}
      <button type="button" disabled={busy} onClick={onReload}>{t('retry')}</button>
    </div>}
    {load === null && <p className="sd-small sd-muted" role="status">{t('loading')}</p>}
    {load !== null && load.error === null && rows.length === 0 && <p className="sd-small sd-muted">{t('extensionsEmpty')}</p>}
    {rows.length > 0 && <ul className="sd-extlist">
      {rows.map(row => <li key={row.id} className="sd-extrow" data-state={row.state} data-extension-id={row.id} data-builtin={row.builtin ? 'true' : undefined}>
        <div className="sd-exthead">
          <strong>{row.name}</strong>
          {row.builtin && <span className="sd-extcap" data-builtin="true">{t('extensionBuiltin')}</span>}
          <span className="sd-small sd-muted">{row.id}{row.version === null ? '' : ` · v${row.version}`}</span>
          <span className="sd-extstate" data-state={row.state}>{stateLabel(row.state)}{row.state === 'mounted' ? ` · ${t('extensionFacetCount', { count: row.facets })}` : ''}</span>
        </div>
        {row.description !== null && <p className="sd-small sd-muted">{row.description}</p>}
        <div className="sd-row sd-extcaps">
          {row.requires.length === 0 && row.optional.length === 0 && <span className="sd-small sd-muted">{t('extensionNoCapabilities')}</span>}
          {row.requires.map(id => <span key={`r:${id}`} className="sd-extcap" data-required="true" title={describeCapability(id, t)}>{id}</span>)}
          {row.optional.map(id => <span key={`o:${id}`} className="sd-extcap" data-optional="true" title={describeCapability(id, t)}>{id}</span>)}
        </div>
        {row.detail !== null && <p className="sd-small sd-extproblem" role="alert">{row.detail}</p>}
        <div className="sd-row">
          <button type="button" disabled={busy} onClick={() => onToggle(row.id, !row.enabled)}>{row.enabled ? t('extensionDisable') : t('extensionEnable')}</button>
        </div>
      </li>)}
    </ul>}
    {rows.some(row => row.builtin) && <p className="sd-small sd-muted">{t('extensionBuiltinHint')}</p>}
    <div className="sd-row sd-extfoot">
      <button type="button" disabled={busy} onClick={onReload}>{t('extensionReload')}</button>
      <span className="sd-small sd-muted">{t('extensionLoadedCount', { mounted: mountedCount, facets: facetCount })}</span>
    </div>
  </Modal>
}
