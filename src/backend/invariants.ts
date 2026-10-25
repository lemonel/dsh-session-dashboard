import { isDeepStrictEqual } from 'node:util'
import { boardSchema, fromStoredBoard, PROJECT_GROUP_ID, storedBoardSchema, EMPTY, type Board, type Dimension } from '../shared/model.js'
import { fail } from '../shared/commands.js'

function unique(values: readonly string[], name: string): Set<string> {
  const result = new Set(values)
  if (result.size !== values.length) fail('INVALID', `${name} 存在重复身份`)
  return result
}
/** Validate persisted aggregates as-is: never repair, default or silently discard damaged records. */
export function parseBoard(value: unknown): Board {
  const board = boardSchema.parse(value)
  // Input normalizers are convenient for RPC, but durable records must be canonical already.
  if (!isDeepStrictEqual(board, value)) fail('INVALID', '持久化记录不是规范格式；拒绝静默规范化或修复')
  const projects = unique(board.projects.map(row => row.id), '项目')
  const tags = unique(board.tags.map(row => row.id), '标签')
  const groups = unique(board.tagGroups.map(row => row.id), '标签组')
  unique(board.tagGroups.map(row => row.name.normalize('NFKC').toLocaleLowerCase()), '标签组名称')
  for (const tag of board.tags) if (tag.groupId !== null && !groups.has(tag.groupId)) fail('INVALID', '标签引用了缺失的标签组')
  for (const group of board.tagGroups) if (group.id === EMPTY) fail('INVALID', '空值分组不是可编辑标签组')
  unique(board.cards.map(row => row.membershipId), '成员')
  for (const [name, rows] of [['项目', board.projects], ['标签', board.tags]] as const) {
    unique(rows.map(row => row.name.normalize('NFKC').toLocaleLowerCase()), name)
    for (const row of rows) if (row.id === EMPTY) fail('INVALID', '空值分组不是可编辑标签')
  }
  const nativeStatuses = ['in_progress', 'pending_confirm', 'pending_review', 'accepted']
  const statuses = unique(board.statuses.map(row => row.id), '状态')
  unique(board.statuses.map(row => row.name.normalize('NFKC').toLocaleLowerCase()), '状态名称')
  for (const status of board.statuses) {
    if (status.id === EMPTY || nativeStatuses.includes(status.id)) fail('INVALID', '自定义状态冒用内置身份')
  }
  const dimensions: Record<Dimension, Set<string>> = {
    status: new Set([...nativeStatuses, ...statuses]),
    project: new Set([...projects, EMPTY]), tag: tags, tagGroup: groups,
  }
  for (const dimension of ['status', 'project', 'tag', 'tagGroup'] as const) {
    const order = board.orders[dimension]
    const actual = unique(order.ids, `${dimension} 顺序`)
    if (order.dimension !== dimension || actual.size !== dimensions[dimension].size || [...actual].some(id => !dimensions[dimension].has(id))) fail('INVALID', `${dimension} 顺序与选项不一致`)
  }
  for (const project of board.projects) {
    unique(project.tagIds, '项目标签')
    if (project.tagIds.some(id => !tags.has(id))) fail('INVALID', '项目引用了缺失标签')
  }
  for (const card of board.cards) {
    if (card.placement.kind === 'builtin' && card.placement.status !== card.status) fail('INVALID', '内置位置与执行处置不一致')
    if (card.placement.kind !== 'builtin' && !(card.status === 'accepted' && ['completed', 'not_started'].includes(card.runtime.phase)) && !(card.status === 'in_progress' && card.runtime.episodeId === null && ['not_started', 'unknown'].includes(card.runtime.phase))) fail('INVALID', '未解决执行不能藏入自定义或未设置位置')
    if (card.placement.kind === 'custom') {
      if (!statuses.has(card.placement.statusId)) fail('INVALID', '自定义位置引用了缺失状态')
      if (card.status !== 'accepted' && (card.runtime.episodeId !== null || card.status !== 'in_progress')) fail('INVALID', '未解决执行不能藏入自定义状态')
    }
    if (card.origin && (card.origin.episodeId !== card.runtime.episodeId || card.origin.episodeOrder !== card.runtime.episodeOrder)) fail('INVALID', '执行来源不属于当前轮次')
    if (!card.runtime.episodeId && card.origin) fail('INVALID', '没有执行轮次不能保存来源')
    if (card.placementWitness && (card.placementWitness.workflowRevision !== card.workflowRevision || card.placementWitness.cursor > card.runtime.cursor)) fail('INVALID', '状态来源证明与工作版本不一致')
    if (card.projectId !== null && !projects.has(card.projectId)) fail('INVALID', '会话引用了缺失分类')
    unique(card.tagIds, '会话标签')
    if (card.tagIds.some(id => !tags.has(id))) fail('INVALID', '会话引用了缺失标签')
    if (card.status === 'pending_confirm' || card.status === 'pending_review') {
      if (card.runtime.phase !== 'completed' || !card.runtime.episodeId || card.reviewAt === null || card.acceptedAt !== null || card.decision !== null) fail('INVALID', '待确认或待验收会话缺少当前正常完成轮次')
    } else if (card.reviewAt !== null) fail('INVALID', '非待确认/待验收会话不能持有复核时间')
    if (card.status === 'accepted') {
      if (card.acceptedAt === null || !card.decision || !['accepted', 'historical'].includes(card.decision.kind)) fail('INVALID', '已验收会话缺少人工决定')
      if (card.decision.kind === 'accepted' && (!card.runtime.episodeId || card.decision.episodeId !== card.runtime.episodeId || card.runtime.phase !== 'completed')) fail('INVALID', '验收轮次与运行事实不一致')
      if (card.decision.kind === 'historical' && card.runtime.episodeId !== null) fail('INVALID', '历史验收不能覆盖已知执行轮次')
    } else if (card.acceptedAt !== null) fail('INVALID', '未验收会话不能持有验收时间')
    if (card.decision && card.decision.kind !== 'historical' && card.decision.episodeId !== card.runtime.episodeId) fail('INVALID', '人工决定不属于当前执行轮次')
    if (card.decision && (card.decision.kind === 'accepted' || card.decision.kind === 'historical') && card.status !== 'accepted') fail('INVALID', '验收决定与卡片进度不一致')
    if (card.decision && (card.decision.kind === 'returned' || card.decision.kind === 'reopened') && card.status !== 'in_progress') fail('INVALID', '退回决定与卡片进度不一致')
    if ((card.status === 'pending_confirm' || card.status === 'pending_review') && card.reviewAt !== card.runtime.endedAt) fail('INVALID', '复核时间不属于当前正常结束')
    if (card.status === 'accepted' && card.acceptedAt !== card.decision?.at) fail('INVALID', '验收时间不属于当前人工决定')
    if (card.decision?.kind === 'historical' && (card.decision.episodeId !== null || card.runtime.episodeOrder !== 0 || card.runtime.phase !== 'not_started')) fail('INVALID', '历史初始化不能包含已知执行轮次')
    if (card.metadataRevision > board.revision || card.lifecycleRevision > board.revision || card.workflowRevision > board.revision) fail('INVALID', '卡片版本超过聚合版本')
    if (card.runtime.episodeOrder > card.runtime.cursor) fail('INVALID', '执行顺序超过来源游标')
    if (card.runtime.phase === 'completed' && (!card.runtime.episodeId || card.runtime.endedAt === null)) fail('INVALID', '完成事实缺少轮次或结束时间')
  }
  return board
}

/** Validate the durable tag-only aggregate and return the runtime projection the
 *  rest of the app (and the API) uses. Rejects a card holding two values of one
 *  group, a carried tag outside the project group, and any non-canonical payload. */
export function parseStoredBoard(value: unknown): Board {
  const stored = storedBoardSchema.parse(value)
  if (!isDeepStrictEqual(stored, value)) fail('INVALID', '持久化记录不是规范格式；拒绝静默规范化或修复')
  unique(stored.tags.map(row => row.id), '标签')
  unique(stored.tags.map(row => row.name.normalize('NFKC').toLocaleLowerCase()), '标签名称')
  const groups = unique(stored.tagGroups.map(row => row.id), '标签组')
  unique(stored.tagGroups.map(row => row.name.normalize('NFKC').toLocaleLowerCase()), '标签组名称')
  if (!groups.has(PROJECT_GROUP_ID)) fail('INVALID', '缺少内置项目标签组')
  const projectGroup = stored.tagGroups.find(row => row.id === PROJECT_GROUP_ID)
  if (projectGroup === undefined || !projectGroup.builtin) fail('INVALID', '项目标签组必须是内置组')
  const byId = new Map(stored.tags.map(tag => [tag.id, tag]))
  for (const tag of stored.tags) {
    if (tag.groupId !== null && !groups.has(tag.groupId)) fail('INVALID', '标签引用了缺失的标签组')
    if (tag.groupId === PROJECT_GROUP_ID && !groups.has(PROJECT_GROUP_ID)) fail('INVALID', '项目标签缺少项目组')
    if (tag.groupId !== PROJECT_GROUP_ID && tag.carriedTagIds.length > 0) fail('INVALID', '只有项目标签可以携带公共标签')
    for (const carried of tag.carriedTagIds) if (!byId.has(carried)) fail('INVALID', '公共标签引用了缺失的标签')
  }
  for (const card of stored.cards) {
    const seen = new Set<string>()
    for (const tagId of card.tagIds) {
      const tag = byId.get(tagId)
      if (tag === undefined) fail('INVALID', '会话引用了缺失的标签')
      const bucket = tag.groupId ?? EMPTY
      if (seen.has(bucket)) fail('INVALID', '同一标签组在一个会话里只能有一个值')
      seen.add(bucket)
    }
    if (card.tagIds.length !== new Set(card.tagIds).size) fail('INVALID', '会话标签存在重复身份')
  }
  // The runtime checks (project/tag/status references, revisions, workflow facts)
  // still run on the projection, so there is exactly one place for those rules.
  return parseBoard(fromStoredBoard(stored))
}
