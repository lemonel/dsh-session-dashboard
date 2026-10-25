import { z } from 'zod'
import { decisionSchema, idSchema, placementSchema, projectSnapshotSchema, revisionSchema, statusSnapshotSchema, timeSchema } from './model.js'

/** Stored business-history rows keep the project-state snapshot a decision was made
 *  against. Older rows carry the retired project-scoped shape; both stay readable. */
const legacyStateSnapshotSchema = z.object({ projectId: idSchema, projectName: z.string().min(1).max(80), projectRevision: revisionSchema, stateId: idSchema, stateName: z.string().min(1).max(80), stateRevision: revisionSchema }).strict()
const historyStateSchema = z.union([statusSnapshotSchema, legacyStateSnapshotSchema])
const historyOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), episodeId: idSchema, episodeOrder: revisionSchema, state: historyStateSchema }).strict(),
  z.object({ kind: z.literal('unspecified'), episodeId: idSchema, episodeOrder: revisionSchema, reason: z.enum(['legacy', 'before_membership', 'no_state', 'unverified_start', 'cross_project', 'source_unavailable']) }).strict(),
])

/** Durable business history is separate from the expiring extension notification feed.
 * Capacity pruning is transactional and explicitly visible to readers. */
export const HISTORY_MEMBER_CAPACITY = 1000
export const HISTORY_STORE_CAPACITY = 100000
export const HISTORY_PAGE_LIMIT = 100
export const historyRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), sequence: revisionSchema,
  sessionId: idSchema, membershipId: z.string().uuid(),
  kind: z.enum(['legacy_decision', 'episode_started', 'state_changed', 'project_moved', 'accepted', 'returned', 'reopened']),
  at: timeSchema, episodeId: idSchema.nullable(), origin: historyOriginSchema.nullable(),
  fromProjectId: idSchema.nullable(), toProjectId: idSchema.nullable(), from: placementSchema, to: placementSchema,
  /** Frozen transaction-time names, including never-executed state adjustments.
   * Legacy records cannot reconstruct these and must explicitly store null. */
  fromProject: projectSnapshotSchema.nullable(), toProject: projectSnapshotSchema.nullable(),
  fromState: historyStateSchema.nullable(), toState: historyStateSchema.nullable(),
  decision: decisionSchema.nullable(), requestId: z.string().uuid().nullable(),
}).strict()
export const historyQuerySchema = z.object({ sessionId: idSchema, membershipId: z.string().uuid(), after: revisionSchema.optional(), limit: z.number().int().min(1).max(HISTORY_PAGE_LIMIT) }).strict()
export const historyPageSchema = z.object({
  sessionId: idSchema, membershipId: z.string().uuid(), records: z.array(historyRecordSchema).max(HISTORY_PAGE_LIMIT),
  nextAfter: revisionSchema.nullable(), retainedFrom: revisionSchema, highWatermark: revisionSchema, truncated: z.boolean(), gap: z.boolean(),
}).strict()
export type HistoryRecord = z.infer<typeof historyRecordSchema>
export type HistoryQuery = z.infer<typeof historyQuerySchema>
export type HistoryPage = z.infer<typeof historyPageSchema>
