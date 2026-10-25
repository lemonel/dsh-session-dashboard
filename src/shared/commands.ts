import { z } from 'zod'
import { candidateSchema, dimensionSchema, hostArchiveSchema, idSchema, preferencesSchema, revisionSchema, runtimeSchema, snapshotSchema } from './model.js'
export { HISTORY_MEMBER_CAPACITY, HISTORY_STORE_CAPACITY, HISTORY_PAGE_LIMIT, historyRecordSchema, historyQuerySchema, historyPageSchema } from './history.js'
export type { HistoryRecord, HistoryQuery, HistoryPage } from './history.js'

const id = idSchema, version = revisionSchema
const labelInput = { name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }
const cardVersion = { sessionId: id, membershipId: z.string().uuid(), expectedMetadataRevision: version }
export const workflowBindingSchema = z.object({ ...cardVersion, expectedLifecycleRevision: version, expectedWorkflowRevision: version, episodeId: id.nullable() }).strict()
export const stateTargetSchema = z.object({ statusId: id, expectedStatusRevision: version }).strict()
export const stateSelectionSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('custom'), target: stateTargetSchema }).strict(), z.object({ kind: z.literal('unset') }).strict()])
export const reviewDestinationSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('stay') }).strict(), z.object({ kind: z.literal('custom'), target: stateTargetSchema }).strict()])
export const moveDestinationSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('preserve') }).strict(), z.object({ kind: z.literal('custom'), target: stateTargetSchema }).strict(), z.object({ kind: z.literal('unset') }).strict()])
/** The service epoch binds both present and absent membership to one real capture.
 * It is evidence to recheck, never authorization and never an in-memory token table. */
export const sessionInspectionBindingSchema = z.object({
  serviceId: z.string().uuid(), boardRevision: version, membershipId: z.string().uuid().nullable(),
  metadataRevision: version.nullable(), lifecycleRevision: version.nullable(), workflowRevision: version.nullable(),
  runtimeFingerprint: z.string().max(512), sourceIdentity: z.string().max(128).nullable(), sourceCursor: version.nullable(), hostArchiveGeneration: z.string().min(1).max(256),
}).strict()
export const inspectionQuerySchema = z.object({ sessionId: id }).strict()
export const sessionInspectionSchema = z.object({ snapshot: snapshotSchema, candidate: candidateSchema, binding: sessionInspectionBindingSchema }).strict()
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_project'), ...labelInput, tagIds: z.array(id).max(200) }).strict(),
  z.object({ type: z.literal('update_project'), projectId: id, expectedProjectRevision: version, ...labelInput, tagIds: z.array(id).max(200) }).strict(),
  z.object({ type: z.literal('delete_project'), projectId: id, expectedProjectRevision: version, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('choose_state'), ...workflowBindingSchema.shape, selection: stateSelectionSchema }).strict(),
  z.object({ type: z.literal('create_label'), dimension: z.enum(['status', 'tag']), groupId: id.nullable().optional(), ...labelInput }).strict(),
  z.object({ type: z.literal('update_label'), dimension: z.enum(['status', 'tag']), id, expectedRevision: version, groupId: id.nullable().optional(), ...labelInput }).strict(),
  z.object({ type: z.literal('delete_label'), dimension: z.enum(['status', 'tag']), id, expectedRevision: version }).strict(),
  z.object({ type: z.literal('create_tag_group'), ...labelInput }).strict(),
  z.object({ type: z.literal('update_tag_group'), groupId: id, expectedRevision: version, ...labelInput }).strict(),
  z.object({ type: z.literal('delete_tag_group'), groupId: id, expectedRevision: version }).strict(),
  z.object({ type: z.literal('reorder'), dimension: dimensionSchema, ids: z.array(id).max(10000), expectedRevision: version }).strict(),
  z.object({ type: z.literal('add_card'), sessionId: id, projectId: id.nullable(), inspection: sessionInspectionBindingSchema }).strict(),
  z.object({ type: z.literal('edit_card'), ...cardVersion, tagIds: z.array(id).max(200), titleOverride: z.string().trim().max(160).nullable(), progress: z.string().max(500) }).strict(),
  z.object({ type: z.literal('move_project'), ...workflowBindingSchema.shape, projectId: id.nullable(), destination: moveDestinationSchema, expectedTargetProjectRevision: version.nullable() }).strict(),
  z.object({ type: z.literal('review'), ...workflowBindingSchema.shape, action: z.enum(['accept', 'return', 'reopen']), confirmed: z.boolean(), destination: reviewDestinationSchema }).strict(),
  z.object({ type: z.literal('confirm_review'), ...workflowBindingSchema.shape }).strict(),
  z.object({ type: z.literal('rebaseline_source'), ...cardVersion, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('archive'), ...cardVersion, archived: z.boolean(), confirmedRunning: z.boolean() }).strict(),
  z.object({ type: z.literal('remove_card'), ...cardVersion, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('preferences'), expectedRevision: version, value: preferencesSchema.omit({ revision: true }) }).strict(),
  z.object({ type: z.literal('resync'), sessionId: id.nullable() }).strict(),
])
export const mutationSchema = z.object({ apiVersion: z.literal(2), serviceId: z.string().uuid(), requestId: z.string().uuid(), command: commandSchema }).strict()
export const candidateQuerySchema = z.object({ search: z.string().max(200), offset: version, limit: z.number().int().min(1).max(100), membership: z.enum(['all', 'untracked', 'tracked']).optional(), hostArchive: z.enum(['all', 'active', 'archived']).optional(), generation: z.string().min(1).max(256).nullable().optional() }).strict()
export const candidatesPageSchema = z.object({ items: z.array(candidateSchema).max(100), total: version, nextOffset: version.nullable(), generation: z.string().max(256) }).strict()
export const observationSchema = z.object({ runtime: runtimeSchema, title: z.string().max(1000), workspace: z.string().max(4096).nullable(), activityAt: z.number().int().nonnegative().nullable(), hostArchive: hostArchiveSchema }).strict()
export const navigationQuerySchema = z.object({ sessionId: id, expectedLifecycleRevision: version.optional(), runtimeFingerprint: z.string().max(512).optional() }).strict()
export const navigationResultSchema = z.object({ sessionId: id, allowed: z.boolean(), reason: z.string().max(1000).nullable(), hostArchive: hostArchiveSchema }).strict()
export type WorkflowBinding = z.infer<typeof workflowBindingSchema>
export type StateTarget = z.infer<typeof stateTargetSchema>
export type StateSelection = z.infer<typeof stateSelectionSchema>
export type InspectionQuery = z.infer<typeof inspectionQuerySchema>
export type SessionInspectionBinding = z.infer<typeof sessionInspectionBindingSchema>
export type SessionInspection = z.infer<typeof sessionInspectionSchema>
export type NavigationQuery = z.infer<typeof navigationQuerySchema>
export type NavigationResult = z.infer<typeof navigationResultSchema>
export type Command = z.infer<typeof commandSchema>
export type Mutation = z.infer<typeof mutationSchema>
export type CandidateQuery = z.infer<typeof candidateQuerySchema>
export type HostObservation = z.infer<typeof observationSchema>
export type CandidatePage = z.infer<typeof candidatesPageSchema>
export type DomainErrorCode = 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'IN_USE' | 'UNAVAILABLE' | 'REVIEW_STALE' | 'FORBIDDEN' | 'STORAGE' | 'CLOSED' | 'UNSUPPORTED_API'
export type ErrorParameters = Readonly<Record<string, string | number | boolean | null>>
export class DashboardError extends Error {
  constructor(readonly code: DomainErrorCode, message: string, readonly messageKey?: string, readonly params?: ErrorParameters) { super(message); this.name = 'DashboardError' }
}
export function fail(code: DomainErrorCode, message: string, messageKey?: string, params?: ErrorParameters): never { throw new DashboardError(code, message, messageKey, params) }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
