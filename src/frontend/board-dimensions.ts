import type { Board, Card } from '../shared/model.js'
import { PROJECT_GROUP_ID, effectiveTagIds, tagGroupOf } from '../shared/model.js'
import type { Translator } from './i18n.js'
import { statusBucket, statusBucketColor, statusBucketLabel, statusRowIds } from './view-model.js'

import { STATUS_DIMENSION, UNGROUPED_DIMENSION } from './filter-model.js'
export { STATUS_DIMENSION, UNGROUPED_DIMENSION }

/** The board can group sessions by projects, by statuses, by any tag group and by
 *  the ungrouped tags. Projects keep their own grid (drag, reorder, creation); every
 *  other dimension renders value cards through the same session row. */
export const PROJECT_DIMENSION = PROJECT_GROUP_ID

export interface DimensionOption { key: string; name: string }
export interface GroupBucket { key: string; name: string; color: string | null; cards: Card[] }

/** Tags of one group in the durable order first, then anything not listed yet. */
export function orderedGroupTags(board: Board, groupId: string | null) {
  const order = board.orders.tag.ids
  return [
    ...order.flatMap(id => { const tag = board.tags.find(value => value.id === id && (value.groupId ?? null) === groupId); return tag ? [tag] : [] }),
    ...board.tags.filter(tag => (tag.groupId ?? null) === groupId && !order.includes(tag.id)),
  ]
}

function orderedGroups(board: Board) {
  const listed = board.orders.tagGroup.ids.flatMap(id => board.tagGroups.find(group => group.id === id) ?? [])
  return [...listed, ...board.tagGroups.filter(group => !board.orders.tagGroup.ids.includes(group.id))]
}

/** Every value the board can group by: projects, statuses, each tag group, and the
 *  ungrouped tags when any exist. */
export function dimensionOptions(board: Board, t: Translator): DimensionOption[] {
  const projectGroup = board.tagGroups.find(group => group.id === PROJECT_DIMENSION)
  const options: DimensionOption[] = [
    { key: PROJECT_DIMENSION, name: projectGroup?.name ?? t('projectsHome') },
    { key: STATUS_DIMENSION, name: t('status') },
    ...orderedGroups(board).filter(group => group.id !== PROJECT_DIMENSION).map(group => ({ key: group.id, name: group.name })),
  ]
  if (board.tags.some(tag => (tag.groupId ?? null) === null)) options.push({ key: UNGROUPED_DIMENSION, name: t('groupNone') })
  return options
}

export function dimensionName(board: Board, dimension: string, t: Translator): string {
  return dimensionOptions(board, t).find(option => option.key === dimension)?.name ?? t('projectsHome')
}

/** Buckets for one dimension, in display order. Sessions that carry no value in the
 *  chosen dimension land in the final unset bucket, never in a hidden overflow. */
export function dimensionBuckets(board: Board, cards: readonly Card[], dimension: string, t: Translator): GroupBucket[] {
  if (dimension === STATUS_DIMENSION) {
    return statusRowIds(board).flatMap(id => {
      const members = cards.filter(card => statusBucket(card) === id)
      return members.length > 0 ? [{ key: id, name: statusBucketLabel(board, id, t), color: statusBucketColor(board, id), cards: members }] : []
    })
  }
  // Projects keep their own grid: they also carry creation, reorder and empty cards.
  if (dimension === PROJECT_DIMENSION) return []
  const groupId = dimension === UNGROUPED_DIMENSION ? null : dimension
  const buckets = orderedGroupTags(board, groupId).flatMap(tag => {
    const members = cards.filter(card => effectiveTagIds(board, card).includes(tag.id))
    return members.length > 0 ? [{ key: tag.id, name: tag.name, color: tag.color, cards: members }] : []
  })
  const unset = cards.filter(card => effectiveTagIds(board, card).every(id => tagGroupOf(board.tags, id) !== groupId))
  if (unset.length > 0) buckets.push({ key: 'unset', name: t('unsetGroup'), color: null, cards: unset })
  return buckets
}
