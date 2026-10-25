import type { CSSProperties } from 'react'
import type { Board, Card } from '../shared/model.js'
import { EMPTY, PROJECT_GROUP_ID, tagGroupOf } from '../shared/model.js'
import { statusBucket, statusBucketColor, statusBucketLabel, statusSummary } from './view-model.js'
import { effectiveTagIds } from '../shared/model.js'
import { useTranslator } from './i18n.js'
import { FilterIcon, Popover } from './Popover.js'

/** The filter is a map from one dimension to the values picked in it: `status`
 *  for the built-in/custom statuses, a tag group id for its tags, and the
 *  project group id for projects. */
export const STATUS_DIMENSION = 'status'
export const UNGROUPED_DIMENSION = '__ungrouped__'
export type FilterSelections = Record<string, string[]>

export function selectedCount(selections: FilterSelections): number {
  return Object.values(selections).reduce((sum, ids) => sum + ids.length, 0)
}

/** Different dimensions are ANDed; the values picked inside one dimension are
 *  ORed, so Shift-clicking two values of one tag group means "either one". */
export function matchesFilter(board: Board, card: Card, selections: FilterSelections): boolean {
  for (const [key, ids] of Object.entries(selections)) {
    if (ids.length === 0) continue
    if (key === STATUS_DIMENSION) { if (!ids.includes(statusBucket(card))) return false; continue }
    if (key === PROJECT_GROUP_ID) { if (card.projectId === null || !ids.includes(card.projectId)) return false; continue }
    const groupId = key === UNGROUPED_DIMENSION ? null : key
    const owned = effectiveTagIds(board, card).filter(tagId => tagGroupOf(board.tags, tagId) === groupId)
    if (!owned.some(tagId => ids.includes(tagId))) return false
  }
  return true
}

interface FilterValue { id: string; name: string; color: string | null; count: number }
interface FilterRow { key: string; name: string; values: FilterValue[] }

/** One row per dimension, ordered like the board itself: statuses, the configured
 *  tag groups, then the ungrouped tags. Counts cover every non-archived session and
 *  never change with the selection, so a chip cannot hide its own undo action. */
export function filterRows(board: Board, cards: readonly Card[]): FilterRow[] {
  const members = cards.filter(card => card.archivedAt === null)
  const rows: FilterRow[] = []
  const statuses = statusSummary(board, members)
  if (statuses.length > 0) rows.push({
    key: STATUS_DIMENSION, name: '', values: statuses.map(({ id, count }) => ({ id, name: '', color: null, count })),
  })
  const tagOrder = board.orders.tag.ids
  const orderedTags = (groupId: string | null) => [
    ...tagOrder.flatMap(id => { const tag = board.tags.find(value => value.id === id && (value.groupId ?? null) === groupId); return tag ? [tag] : [] }),
    ...board.tags.filter(tag => (tag.groupId ?? null) === groupId && !tagOrder.includes(tag.id)),
  ]
  const groupIds = [...board.orders.tagGroup.ids.filter(id => board.tagGroups.some(group => group.id === id)), ...board.tagGroups.map(group => group.id).filter(id => !board.orders.tagGroup.ids.includes(id))]
  for (const groupId of groupIds) {
    const group = board.tagGroups.find(value => value.id === groupId)
    if (!group) continue
    if (groupId === PROJECT_GROUP_ID) {
      const projectIds = [...board.orders.project.ids.filter(id => id !== EMPTY), ...board.projects.map(project => project.id).filter(id => !board.orders.project.ids.includes(id))]
      const values = projectIds.flatMap(id => {
        const project = board.projects.find(value => value.id === id)
        return project ? [{ id, name: project.name, color: project.color, count: members.filter(card => card.projectId === id).length }] : []
      })
      if (values.length > 0) rows.push({ key: groupId, name: group.name, values })
      continue
    }
    const values = orderedTags(groupId).map(tag => ({ id: tag.id, name: tag.name, color: tag.color, count: members.filter(card => effectiveTagIds(board, card).includes(tag.id)).length }))
    if (values.length > 0) rows.push({ key: groupId, name: group.name, values })
  }
  const ungrouped = orderedTags(null).map(tag => ({ id: tag.id, name: tag.name, color: tag.color, count: members.filter(card => effectiveTagIds(board, card).includes(tag.id)).length }))
  if (ungrouped.length > 0) rows.push({ key: UNGROUPED_DIMENSION, name: '', values: ungrouped })
  return rows
}

/** The top-right selector: one facet row per dimension, any number of values per
 *  row (Shift-click adds another), and the panel stays open so the reader can
 *  stack dimensions without reopening it. */
export function FilterSelector({ board, cards, selections, onChange, onManageTags }: {
  board: Board
  cards: readonly Card[]
  selections: FilterSelections
  onChange: (next: FilterSelections) => void
  onManageTags?: () => void
}) {
  const t = useTranslator()
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
  const label = (row: FilterRow, value: FilterValue, on: boolean): string => row.key === STATUS_DIMENSION
    ? t(on ? 'statusCountFilterActive' : 'statusCountFilter', { name: statusBucketLabel(board, value.id, t), count: value.count })
    : t(on ? 'filterValueActive' : 'filterValue', { name: value.name, count: value.count })
  return <Popover label={t('filters')} align="end" triggerClassName="sd-filtertrigger" panelClassName="sd-filterpanel"
    trigger={<><FilterIcon/><span>{t('filters')}</span>{active > 0 && <b className="sd-filtercount" data-filter-count={String(active)}>{active}</b>}</>}>
    <p className="sd-small sd-muted sd-filtermeta" role="status">{t('filterTotal', { count: total })}</p>
    {rows.map(row => <section className="sd-filterrow" key={row.key} aria-label={row.key === STATUS_DIMENSION ? t('status') : row.key === UNGROUPED_DIMENSION ? t('groupNone') : row.name}>
      <h4>{row.key === STATUS_DIMENSION ? t('status') : row.key === UNGROUPED_DIMENSION ? t('groupNone') : row.name}</h4>
      <div className="sd-statuscounts">{row.values.map(value => {
        const on = (selections[row.key] ?? []).includes(value.id)
        const text = label(row, value, on)
        const color = row.key === STATUS_DIMENSION ? statusBucketColor(board, value.id) : value.color
        return <button type="button" className="sd-statuscount" key={value.id} aria-pressed={on} aria-label={text} title={text}
          data-filter-value={`${row.key}:${value.id}`} data-status-count={row.key === STATUS_DIMENSION ? value.id : undefined}
          onClick={event => pick(row.key, value.id, event.shiftKey)} disabled={!on && value.count === 0}
          style={color === null ? undefined : { '--sd-chip-color': color } as CSSProperties}>
          <span className="sd-state-name">{row.key === STATUS_DIMENSION ? statusBucketLabel(board, value.id, t) : value.name}</span><b>{value.count}</b>
        </button>
      })}</div>
    </section>)}
    <p className="sd-small sd-muted">{t('filterHint')}</p>
    <div className="sd-row sd-between">
      <span className="sd-small sd-muted">{active === 0 ? t('filterIdle') : t('filterApplied', { count: active })}</span>
      <div className="sd-row">
        <button type="button" className="sd-small" disabled={active === 0} onClick={() => onChange({})}>{t('clearFilters')}</button>
        {onManageTags && <button type="button" className="sd-small" onClick={onManageTags}>{t('manageTags')}</button>}
      </div>
    </div>
  </Popover>
}
