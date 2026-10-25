import { useState, type CSSProperties } from 'react'
import type { Board, Card } from '../shared/model.js'
import { dimensionName, dimensionOptions, PROJECT_DIMENSION } from './board-dimensions.js'
import { filterRows, selectedCount, STATUS_DIMENSION, UNGROUPED_DIMENSION, type FilterSelections } from './filter-model.js'
import { useTranslator } from './i18n.js'
import { CaretIcon, Popover } from './Popover.js'
import { statusBucketColor, statusBucketLabel } from './view-model.js'

const VIEW_KEY = 'session-dashboard.board-view'
/** The grouping dimension and the collapsed filter categories are presentation, so
 *  they live in this browser like the row heights, not in the durable board. */
export interface BoardView { dimension: string; closed: string[] }

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function readBoardView(): BoardView {
  const store = storage(), fallback: BoardView = { dimension: PROJECT_DIMENSION, closed: [] }
  if (store === null) return fallback
  try {
    const raw = store.getItem(VIEW_KEY)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as { dimension?: unknown; closed?: unknown }
    const dimension = typeof record.dimension === 'string' && record.dimension.length > 0 ? record.dimension : fallback.dimension
    const closed = Array.isArray(record.closed) ? record.closed.filter((key): key is string => typeof key === 'string') : []
    return { dimension, closed }
  } catch { return fallback }
}

export function writeBoardView(view: BoardView): void {
  const store = storage()
  if (store === null) return
  try { store.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* storage unavailable */ }
}

/** The dimension picker: one dropdown listing projects, statuses, every tag group
 *  and the ungrouped tags. Choosing one re-groups the cards below. */
export function DimensionPicker({ board, dimension, onChange }: { board: Board; dimension: string; onChange: (key: string) => void }) {
  const t = useTranslator()
  const options = dimensionOptions(board, t)
  const current = dimensionName(board, dimension, t)
  return <div className="sd-dimension">
    <Popover label={t('groupBy')} align="start" closeOnSelect triggerClassName="sd-dimensiontrigger"
      trigger={<><span className="sd-small sd-muted">{t('groupBy')}</span><b>{current}</b><CaretIcon className="sd-dimensioncaret"/></>}>
      {options.map(option => <button key={option.key} type="button" role="menuitemradio" aria-checked={option.key === dimension}
        className="sd-menu-item" data-dimension={option.key} aria-label={`${t('groupBy')}: ${option.name}`}
        onClick={() => onChange(option.key)}>{option.name}{option.key === dimension && <span className="sd-dimensioncheck" aria-hidden="true">✓</span>}</button>)}
    </Popover>
  </div>
}

/** The filter bar, laid out in the page instead of a popover: one collapsible
 *  section per dimension. A collapsed section keeps only its category name and the
 *  number of values, so the bar stays readable while the values stay one click away. */
export function FilterBar({ board, cards, selections, closed, onChange, onToggleCategory, onExpandAll, onCollapseAll, onManageTags }: {
  board: Board
  cards: readonly Card[]
  selections: FilterSelections
  closed: readonly string[]
  onChange: (next: FilterSelections) => void
  onToggleCategory: (key: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onManageTags?: () => void
}) {
  const t = useTranslator()
  const [extended] = useState(false)
  const rows = filterRows(board, cards)
  const total = cards.filter(card => card.archivedAt === null).length
  const active = selectedCount(selections)
  const pick = (key: string, id: string, extend: boolean) => {
    const ids = selections[key] ?? []
    const next = extend
      ? ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]
      : ids.length === 1 && ids[0] === id ? [] : [id]
    onChange({ ...selections, [key]: next })
  }
  const categoryName = (key: string, name: string): string => key === STATUS_DIMENSION ? t('status') : key === UNGROUPED_DIMENSION ? t('groupNone') : name
  const valueLabel = (key: string, value: { id: string; name: string; count: number }, on: boolean): string => key === STATUS_DIMENSION
    ? t(on ? 'statusCountFilterActive' : 'statusCountFilter', { name: statusBucketLabel(board, value.id, t), count: value.count })
    : t(on ? 'filterValueActive' : 'filterValue', { name: value.name, count: value.count })
  return <div className="sd-filterbar" data-extended={extended ? 'true' : undefined} role="group" aria-label={t('filters')}>
    <p className="sd-small sd-muted sd-filtermeta" role="status">{t('filterTotal', { count: total })}{active > 0 && <> · {t('filterApplied', { count: active })}</>}</p>
    <div className="sd-filtercats">
    {rows.map(row => {
      const name = categoryName(row.key, row.name)
      const open = !closed.includes(row.key)
      const picked = (selections[row.key] ?? []).length
      return <section className="sd-filtercat" key={row.key} data-filter-category={row.key} data-open={open ? 'true' : undefined}>
        <button type="button" className="sd-filtercat-head" aria-expanded={open} aria-label={t(open ? 'filterHideValues' : 'filterShowValues', { name })}
          onClick={() => onToggleCategory(row.key)}>
          <CaretIcon className="sd-filtercat-caret"/>
          <span className="sd-filtercat-name">{name}</span>
          <span className="sd-small sd-muted" aria-hidden="true">{row.values.length}</span>
          {picked > 0 && <b className="sd-filtercount" data-category-count={String(picked)}>{picked}</b>}
        </button>
        {open && <div className="sd-filtervalues">{row.values.map(value => {
          const on = (selections[row.key] ?? []).includes(value.id)
          const text = valueLabel(row.key, value, on)
          const color = row.key === STATUS_DIMENSION ? statusBucketColor(board, value.id) : value.color
          return <button type="button" className="sd-statuscount" key={value.id} aria-pressed={on} aria-label={text} title={text}
            data-filter-value={`${row.key}:${value.id}`} data-status-count={row.key === STATUS_DIMENSION ? value.id : undefined}
            onClick={event => pick(row.key, value.id, event.shiftKey)} disabled={!on && value.count === 0}
            style={color === null ? undefined : { '--sd-chip-color': color } as CSSProperties}>
            <span className="sd-state-name">{row.key === STATUS_DIMENSION ? statusBucketLabel(board, value.id, t) : value.name}</span><b>{value.count}</b>
          </button>
        })}</div>}
      </section>
    })}
    </div>
    <div className="sd-filterfoot">
      <button type="button" className="sd-small" disabled={closed.length === 0} onClick={onExpandAll}>{t('filterExpandAll')}</button>
      <button type="button" className="sd-small" disabled={closed.length >= rows.length} onClick={onCollapseAll}>{t('filterCollapseAll')}</button>
      <button type="button" className="sd-small" disabled={active === 0} onClick={() => onChange({})}>{t('clearFilters')}</button>
      {onManageTags && <button type="button" className="sd-small" onClick={onManageTags}>{t('manageTags')}</button>}
    </div>
  </div>
}
