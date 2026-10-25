import { z } from 'zod'

export const PACKAGE = '@hsx/dsh-session-dashboard'
export const PANEL_ID = 'session-dashboard'
export const EMPTY = '__none__'
export const BOARD_SCHEMA_VERSION = 11 as const
/** The one builtin group that holds project values: a project is a tag. */
export const PROJECT_GROUP_ID = '__project__'
export const idSchema = z.string().min(1).max(240)
export const timeSchema = z.number().int().nonnegative().max(8640000000000000)
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const id = idSchema, time = timeSchema, revision = revisionSchema
/** Execution disposition, NOT a custom state's meaning or main board location. */
export const statusSchema = z.enum(['in_progress', 'pending_confirm', 'pending_review', 'accepted'])
export const dimensionSchema = z.enum(['status', 'project', 'tag', 'tagGroup'])
export const entrySchema = z.enum(['projects', 'project', 'board', 'review', 'attention', 'unassigned', 'archive'])
export const labelSchema = z.object({ id, name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(), createdAt: time, revision }).strict()
/** A tag group is one enumeration: a builtin group is system-owned, so its own
 *  identity is locked while its value list may still be extended. */
export const tagGroupSchema = z.object({ id, name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(), builtin: z.boolean(), revision }).strict()
export const tagSchema = labelSchema.extend({ groupId: id.nullable() })
export const projectSchema = labelSchema.extend({ tagIds: z.array(id).max(200) })
export const projectSnapshotSchema = z.object({ projectId: id, projectName: z.string().min(1).max(80), projectRevision: revision }).strict()
/** A custom status is board-wide: one name, one colour, one order across projects. */
export const statusLabelSchema = labelSchema
export const statusSnapshotSchema = z.object({ statusId: id, statusName: z.string().min(1).max(80), statusRevision: revision }).strict()
export const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), status: statusSchema }).strict(),
  z.object({ kind: z.literal('custom'), statusId: id }).strict(),
  z.object({ kind: z.literal('unset') }).strict(),
])
export const episodeOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), episodeId: id, episodeOrder: revision, state: statusSnapshotSchema }).strict(),
  z.object({ kind: z.literal('unspecified'), episodeId: id, episodeOrder: revision, reason: z.enum(['legacy', 'before_membership', 'no_state', 'unverified_start', 'cross_project', 'source_unavailable']) }).strict(),
])
export const placementWitnessSchema = z.object({ sourceIdentity: z.string().min(1).max(128), cursor: revision, prefixDigest: z.string().regex(/^[0-9a-f]{64}$/), workflowRevision: revision, state: statusSnapshotSchema.nullable() }).strict()
export const attentionSchema = z.enum(['none', 'answer', 'approve', 'blocked', 'paused', 'resume', 'failure', 'interrupted', 'sync'])
export const hostArchiveSchema = z.object({ state: z.enum(['active', 'archived', 'unknown', 'unsupported']), reason: z.string().max(1000).nullable() }).strict()
export type HostArchive = z.infer<typeof hostArchiveSchema>
/** The system's own turn-end reason, passed through 1:1 as an explicit union. The
 *  host's `TurnEndReason` is merge-extensible, but this dashboard only exposes the
 *  variants it knows how to display: a future kind adds one variant here (type, UI
 *  label, tests) instead of leaking an unlabelled string into durable records. The
 *  `error` variant keeps the structured LLM failure identity, never its message. */
export const turnEndCauseSchema = z.enum(['user', 'parent', 'hook', 'disposed', 'legacy'])
export const turnEndSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('blocked') }).strict(),
  z.object({ kind: z.literal('max-tokens') }).strict(),
  z.object({ kind: z.literal('interrupted') }).strict(),
  z.object({ kind: z.literal('forked') }).strict(),
  z.object({ kind: z.literal('aborted'), cause: turnEndCauseSchema }).strict(),
  z.object({ kind: z.literal('error'), error: z.object({ code: z.string().min(1).max(120), status: z.number().int().min(100).max(599).optional() }).strict() }).strict(),
])
export type TurnEnd = z.infer<typeof turnEndSchema>
export type TurnEndCause = z.infer<typeof turnEndCauseSchema>
export const unknownHostArchive = (reason: string | null = 'Host archive facts have not been synchronized'): HostArchive => ({ state: 'unknown', reason })
export const runtimeSchema = z.object({
  sync: z.enum(['synced', 'unknown', 'missing']),
  phase: z.enum(['not_started', 'running', 'waiting_input', 'waiting_approval', 'continuation_pending', 'suspended', 'completed', 'failed', 'interrupted', 'unknown']),
  episodeId: id.nullable(), episodeOrder: revision, startedAt: time.nullable(), endedAt: time.nullable(), cursor: revision, sourceLive: z.boolean(),
  fingerprint: z.string().max(512), explanation: z.string().max(1000).nullable(), attention: attentionSchema,
  /** Live agents under this session right now, including the main one. */
  /** Additive observation: absent means zero, so older payloads stay canonical. */
  activeAgents: z.number().int().nonnegative().max(1000).optional(),
  /** Additive system fact: absent for old payloads and for an unclosed run. */
  turnEnd: turnEndSchema.optional(),
}).strict()
export const decisionSchema = z.object({ kind: z.enum(['accepted', 'returned', 'reopened', 'historical']), episodeId: id.nullable(), at: time }).strict()
export const cardSchema = z.object({
  sessionId: id, membershipId: z.string().uuid(), hostArchive: hostArchiveSchema,
  hostTitle: z.string().max(1000), titleOverride: z.string().trim().max(160).nullable(), workspace: z.string().max(4096).nullable(), projectId: id.nullable(),
  /** Own tags only. Project/effective tags are read-time derivations. */
  tagIds: z.array(id).max(200), progress: z.string().max(500),
  status: statusSchema, placement: placementSchema, origin: episodeOriginSchema.nullable(), placementWitness: placementWitnessSchema.nullable(), workflowRevision: revision,
  runtime: runtimeSchema, decision: decisionSchema.nullable(), joinedAt: time, activityAt: time.nullable(), updatedAt: time,
  reviewAt: time.nullable(), acceptedAt: time.nullable(), archivedAt: time.nullable(), metadataRevision: revision, lifecycleRevision: revision,
}).strict()
const locationSchema = z.object({ x: z.number().nonnegative().finite(), y: z.number().nonnegative().finite() }).strict()
/* v9 keeps only what the overview reads: the view is one list now, so the
 * per-view filter sets, the board grouping and the selected project are gone
 * with the tabs and the project board. */
export const preferencesSchema = z.object({
  revision, entry: entrySchema,
  locations: z.object({ projects: locationSchema }).strict(),
  collapsedProjects: z.array(id).max(10000),
}).strict()
export const orderSchema = z.object({ dimension: dimensionSchema, ids: z.array(id).max(10000), revision }).strict()
export const boardSchema = z.object({
  schemaVersion: z.literal(BOARD_SCHEMA_VERSION), revision,
  projects: z.array(projectSchema).max(10000), tags: z.array(tagSchema), tagGroups: z.array(tagGroupSchema).max(200), statuses: z.array(statusLabelSchema).max(200),
  orders: z.object({ status: orderSchema, project: orderSchema, tag: orderSchema, tagGroup: orderSchema }).strict(),
  cards: z.array(cardSchema), preferences: preferencesSchema,
}).strict()
export const candidateSchema = z.object({ sessionId: id, title: z.string().max(1000), workspace: z.string().max(4096).nullable(), activityAt: time.nullable(), tracked: cardSchema.nullable(), runtime: runtimeSchema.nullable(), hostArchive: hostArchiveSchema }).strict()
export const healthSchema = z.object({ state: z.enum(['ready', 'degraded']), message: z.string().nullable(), lastSyncAt: time.nullable() }).strict()
export const memberGenerationSchema = z.object({ membershipId: z.string().uuid(), cancellationGeneration: revision }).strict()
export const baselineProgressSchema = z.object({
  sessionId: id, state: z.enum(['running', 'ready', 'unavailable']), cursor: revision, total: revision.nullable(), reason: z.string().max(1000).nullable(),
}).strict()
export const snapshotSchema = z.object({
  board: boardSchema, health: healthSchema,
  /** Read-only, transaction-consistent store evidence; absence means unknown, never zero. */
  memberGenerations: z.array(memberGenerationSchema).max(10000).optional(),
  /** Inline long-session source baseline progress; never a card overlay or acceptance state. */
  baseline: z.array(baselineProgressSchema).max(10000).optional(),
}).strict()
export type Status = z.infer<typeof statusSchema>
export type Dimension = z.infer<typeof dimensionSchema>
export type Entry = z.infer<typeof entrySchema>
export type Label = z.infer<typeof labelSchema>
export type Tag = z.infer<typeof tagSchema>
export type TagGroup = z.infer<typeof tagGroupSchema>
export type Project = z.infer<typeof projectSchema>
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>
export type StatusLabel = z.infer<typeof statusLabelSchema>
export type StateSnapshot = z.infer<typeof statusSnapshotSchema>
export type Placement = z.infer<typeof placementSchema>
export type EpisodeOrigin = z.infer<typeof episodeOriginSchema>
export type PlacementWitness = z.infer<typeof placementWitnessSchema>
export type RuntimeFact = z.infer<typeof runtimeSchema>
export type Card = z.infer<typeof cardSchema>
export type Preferences = z.infer<typeof preferencesSchema>
export type Board = z.infer<typeof boardSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type BaselineProgress = z.infer<typeof baselineProgressSchema>
export type Candidate = z.infer<typeof candidateSchema>
export type Health = z.infer<typeof healthSchema>

/** v8 stored the relation edges and the tab/board preference branches. Nothing in
 *  the overview reads either, so a v8 payload is upgraded in memory by the single
 *  parser that both the browser boundary and the store migration use. A payload of
 *  any other version is returned untouched and left to validation. */
export function upgradeBoardPayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const board = value as Record<string, unknown>
  // v9 already had the current runtime fields; v10 added the tag-only durable form,
  // which the runtime never sees. v11 adds the tag-group order, so a v9/v10 payload
  // only needs that one array plus the marker.
  if (board.schemaVersion === 9 || board.schemaVersion === 10) {
    const orders = typeof board.orders === 'object' && board.orders !== null ? board.orders as Record<string, unknown> : {}
    const tagGroups = Array.isArray(board.tagGroups) ? board.tagGroups as { id?: unknown }[] : []
    return {
      ...board,
      schemaVersion: BOARD_SCHEMA_VERSION,
      orders: {
        ...orders,
        tagGroup: orders.tagGroup ?? { dimension: 'tagGroup', ids: tagGroups.flatMap(group => typeof group.id === 'string' ? [group.id] : []), revision: 0 },
      },
    }
  }
  if (board.schemaVersion !== 8) return value
  const preferences = typeof board.preferences === 'object' && board.preferences !== null ? board.preferences as Record<string, unknown> : {}
  const locations = typeof preferences.locations === 'object' && preferences.locations !== null ? preferences.locations as Record<string, unknown> : {}
  const projects = typeof locations.projects === 'object' && locations.projects !== null ? locations.projects : { x: 0, y: 0 }
  const { edges: _edges, preferences: _preferences, ...rest } = board
  return {
    ...rest,
    schemaVersion: BOARD_SCHEMA_VERSION,
    preferences: {
      revision: typeof preferences.revision === 'number' ? preferences.revision : 0,
      entry: 'projects',
      locations: { projects },
      collapsedProjects: Array.isArray(preferences.collapsedProjects) ? preferences.collapsedProjects : [],
    },
  }
}

/** The durable form is tag-only: a project is a value of the builtin
 *  PROJECT_GROUP_ID group, and a card relates to it through tagIds. The runtime
 *  shape (projects + card.projectId) is a projection kept for the API and the UI,
 *  so neither the Host RPC surface nor the sibling plugins change. */
export const storedTagSchema = tagSchema.extend({ carriedTagIds: z.array(id).max(200) })
export const storedCardSchema = cardSchema.omit({ projectId: true })
export const storedBoardSchema = z.object({
  schemaVersion: z.literal(BOARD_SCHEMA_VERSION), revision,
  tags: z.array(storedTagSchema), tagGroups: z.array(tagGroupSchema).max(200), statuses: z.array(statusLabelSchema).max(200),
  orders: z.object({ status: orderSchema, tag: orderSchema, tagGroup: orderSchema }).strict(),
  cards: z.array(storedCardSchema), preferences: preferencesSchema,
}).strict()

/** One card may hold at most one tag per group; an ungrouped tag is its own group. */
export function tagGroupOf(tags: readonly { id: string; groupId: string | null }[], tagId: string): string | null {
  return tags.find(tag => tag.id === tagId)?.groupId ?? null
}

export function toStoredBoard(board: Board): z.infer<typeof storedBoardSchema> {
  const projectIds = new Set(board.projects.map(project => project.id))
  const tagGroups = board.tagGroups.some(group => group.id === PROJECT_GROUP_ID)
    ? board.tagGroups
    : [{ id: PROJECT_GROUP_ID, name: '项目', color: null as string | null, builtin: true, revision: 0 }, ...board.tagGroups]
  const groupOrder = [...board.orders.tagGroup.ids.filter(id => tagGroups.some(group => group.id === id)), ...tagGroups.map(group => group.id).filter(id => !board.orders.tagGroup.ids.includes(id))]
  return {
    schemaVersion: BOARD_SCHEMA_VERSION, revision: board.revision,
    tags: [
      ...board.tags.map(tag => ({ ...tag, carriedTagIds: [] })),
      ...board.projects.map(project => ({ id: project.id, name: project.name, color: project.color, createdAt: project.createdAt, revision: project.revision, groupId: PROJECT_GROUP_ID, carriedTagIds: [...project.tagIds] })),
    ],
    tagGroups,
    statuses: board.statuses,
    orders: {
      status: board.orders.status,
      tagGroup: { dimension: 'tagGroup', ids: groupOrder, revision: board.orders.tagGroup.revision },
      // One durable order carries both runtime dimensions, so its revision is the
      // newer of the two: converting must not invent a new revision on every save.
      tag: { ...board.orders.tag, ids: [...board.orders.project.ids.filter(id => id !== EMPTY), ...board.orders.tag.ids], revision: Math.max(board.orders.tag.revision, board.orders.project.revision) },
    },
    cards: board.cards.map(({ projectId, ...card }) => ({
      ...card,
      tagIds: [...(projectId === null || projectId === undefined || !projectIds.has(projectId) ? [] : [projectId]), ...card.tagIds],
    })),
    preferences: board.preferences,
  }
}

export function fromStoredBoard(stored: z.infer<typeof storedBoardSchema>): Board {
  const groupTags = stored.tags.filter(tag => tag.groupId === PROJECT_GROUP_ID)
  const projectIds = new Set(groupTags.map(tag => tag.id))
  return {
    schemaVersion: BOARD_SCHEMA_VERSION, revision: stored.revision,
    projects: groupTags.map(tag => ({ id: tag.id, name: tag.name, color: tag.color, createdAt: tag.createdAt, revision: tag.revision, tagIds: [...tag.carriedTagIds] })),
    tags: stored.tags.filter(tag => tag.groupId !== PROJECT_GROUP_ID).map(({ carriedTagIds: _carried, ...tag }) => tag),
    tagGroups: stored.tagGroups,
    statuses: stored.statuses,
    orders: {
      status: stored.orders.status,
      tagGroup: stored.orders.tagGroup,
      // One durable order holds every tag; the runtime splits it into the project
      // dimension (values + the unassigned sentinel) and the remaining tags.
      tag: { dimension: 'tag', ids: stored.orders.tag.ids.filter(tagId => !projectIds.has(tagId)), revision: stored.orders.tag.revision },
      project: { dimension: 'project', ids: [...stored.orders.tag.ids.filter(tagId => projectIds.has(tagId)), ...[EMPTY]], revision: stored.orders.tag.revision },
    },
    cards: stored.cards.map(card => {
      const projectId = card.tagIds.find(tagId => projectIds.has(tagId)) ?? null
      return { ...card, projectId, tagIds: card.tagIds.filter(tagId => tagId !== projectId) }
    }),
    preferences: stored.preferences,
  }
}

export function emptyBoard(): Board {
  const origin = () => ({ x: 0, y: 0 })
  return { schemaVersion: BOARD_SCHEMA_VERSION, revision: 0, projects: [], tags: [], tagGroups: [], statuses: [], cards: [],
    orders: {
      status: { dimension: 'status', ids: ['in_progress', 'pending_confirm', 'pending_review', 'accepted'], revision: 0 },
      project: { dimension: 'project', ids: [EMPTY], revision: 0 }, tag: { dimension: 'tag', ids: [], revision: 0 },
      tagGroup: { dimension: 'tagGroup', ids: [], revision: 0 },
    },
    preferences: { revision: 0, entry: 'projects', locations: { projects: origin() }, collapsedProjects: [] },
  }
}
export function unknownRuntime(explanation: string | null = null): RuntimeFact {
  return { sync: 'unknown', phase: 'unknown', episodeId: null, episodeOrder: 0, startedAt: null, endedAt: null, cursor: 0, sourceLive: false, fingerprint: 'unknown', explanation, attention: 'sync', activeAgents: 0 }
}
export const displayTitle = (card: Card): string => card.titleOverride || card.hostTitle || card.sessionId
/** Read-only derivations: neither edits the session's own tags nor copies project data. */
export function projectTagIds(board: Board, card: Card): string[] { return [...(board.projects.find(project => project.id === card.projectId)?.tagIds ?? [])] }
export function effectiveTagIds(board: Board, card: Card): string[] { return [...new Set([...card.tagIds, ...projectTagIds(board, card)])] }
