import type { Board, Card } from '../shared/model.js'
import { EMPTY, PROJECT_GROUP_ID, effectiveTagIds, tagGroupOf } from '../shared/model.js'
import { statusBucket, statusSummary } from './view-model.js'

/** The filter is a map from one dimension to the values picked in it: `status`
 *  for the built-in/custom statuses, a tag group id for its tags, and the
 *  project group id for projects. The board bar renders these rows; this module
 *  only decides what a dimension contains and which sessions it matches. */
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
