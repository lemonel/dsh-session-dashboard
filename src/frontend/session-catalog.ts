import type { CatalogRow } from '../shared/extensions/contract.js'
import type { SessionListSource } from './OfficialCreate.js'

/** Adapt the Client Session Controller catalogue to the extension contract.
 *
 *  Extensions read `getSnapshot()` once per chip, so the mapping is cached against
 *  the snapshot object itself: the controller republishes a new object when
 *  anything changes, and returns the same one otherwise. Without this every row
 *  would re-map the whole catalogue while drawing one strip. */
export function createCatalogSource(list: SessionListSource): { getSnapshot(): { byId: Readonly<Record<string, CatalogRow>> } } {
  let cachedState: unknown = null
  let cached: { byId: Readonly<Record<string, CatalogRow>> } = { byId: {} }
  return {
    getSnapshot() {
      const state = list.getSnapshot()
      if (state === cachedState) return cached
      const byId: Record<string, CatalogRow> = {}
      for (const [id, row] of Object.entries(state.byId)) {
        if (row === undefined || row === null) continue
        const parent = (row as { parentId?: string | null }).parentId
        byId[id] = {
          id,
          title: row.displayTitle || row.title || id,
          parentId: parent ?? null,
          running: row.running === true,
          updatedAt: row.updatedAt ?? 0,
          ...row.projectionValues === undefined ? {} : { projectionValues: row.projectionValues as Readonly<Record<string, unknown>> },
        }
      }
      cachedState = state
      cached = { byId }
      return cached
    },
  }
}
