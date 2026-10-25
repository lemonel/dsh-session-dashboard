import { z } from 'zod'
import { attentionSchema, episodeOriginSchema, hostArchiveSchema, placementSchema, projectSchema, statusSchema, turnEndSchema } from './model.js'

export const DASHBOARD_API_VERSION = 2 as const
export const DOMAIN_EVENT_SCHEMA_VERSION = 2 as const
const identity = z.string().min(1).max(240)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const scopeSchema = z.object({ scopeId: z.string().uuid(), storeId: z.string().uuid(), recoveryId: z.string().uuid() }).strict()
export const capabilitySchema = z.object({ available: z.boolean(), reason: z.string().max(1000).nullable() }).strict()
export const handshakeSchema = z.object({
  apiVersion: z.literal(DASHBOARD_API_VERSION), serviceId: z.string().uuid(), scope: scopeSchema,
  capabilities: z.object({ query: capabilitySchema, events: capabilitySchema, completionReplay: capabilitySchema, evidenceCheck: capabilitySchema, nativeSidebarFilter: capabilitySchema, isolatedExecution: capabilitySchema, externalDelivery: capabilitySchema, projectWorkflow: capabilitySchema, businessHistory: capabilitySchema, sessionInspection: capabilitySchema, sidebarEntry: capabilitySchema }).strict(),
}).strict()
export const cardSummarySchema = z.object({
  sessionId: identity, membershipId: z.string().uuid(), title: z.string().max(1000), projectId: identity.nullable(),
  /** Legacy meaning preserved: these are the session's own tags, never inherited. */
  tagIds: z.array(identity).max(200), projectTagIds: z.array(identity).max(200), effectiveTagIds: z.array(identity).max(400),
  status: statusSchema, placement: placementSchema, origin: episodeOriginSchema.nullable(), workflowRevision: counter,
  episodeId: identity.nullable(), lifecycleRevision: counter, metadataRevision: counter, cancellationGeneration: counter,
  completionCoverage: z.enum(['complete', 'unavailable']), sourceIdentity: z.string().max(128).nullable(), sourceCursor: counter.nullable(), completionEvidenceDigest: z.string().max(128).nullable(),
  archived: z.boolean(), hostArchive: hostArchiveSchema, attention: attentionSchema, sync: z.enum(['synced', 'unknown', 'missing']), sourceLive: z.boolean(), phase: z.string().max(80), endedAt: counter.nullable(), reviewAt: counter.nullable(), /** Absent on summaries persisted before the field existed; null when the host never gave a closer. */ turnEnd: turnEndSchema.nullable().optional(),
}).strict()
export const domainEventSchema = z.object({
  schemaVersion: z.literal(DOMAIN_EVENT_SCHEMA_VERSION), eventId: z.string().uuid(), sequence: counter, scope: scopeSchema,
  sessionId: identity, membershipId: z.string().uuid(), kind: z.enum(['joined', 'removed', 'metadata', 'archived', 'restored', 'host_archive', 'episode_started', 'completed', 'decision', 'source_gap', 'source_baseline', 'workflow', 'project']),
  episodeId: identity.nullable(), sourceIdentity: z.string().max(128).nullable(), sourceCursor: counter.nullable(), occurredAt: counter, observedAt: counter, committedAt: counter, boardRevision: counter,
  historical: z.boolean(), summary: cardSummarySchema.nullable(), evidenceDigest: z.string().max(128).nullable(), reason: z.string().max(1000).nullable(),
}).strict()
export const publicSnapshotSchema = z.object({ handshake: handshakeSchema, boardRevision: counter, highWatermark: counter, retainedFrom: counter, cards: z.array(cardSummarySchema).max(10000), projects: z.array(projectSchema).max(10000) }).strict()
export const eventPageSchema = z.object({ handshake: handshakeSchema, highWatermark: counter, retainedFrom: counter, nextCursor: counter, events: z.array(domainEventSchema).max(200), gap: z.boolean() }).strict()
export const publicQuerySchema = z.object({ apiVersion: z.literal(DASHBOARD_API_VERSION), serviceId: z.string().uuid().optional() }).strict()
export const eventQuerySchema = publicQuerySchema.extend({ after: counter, limit: z.number().int().min(1).max(200) }).strict()
export type DashboardScope = z.infer<typeof scopeSchema>
export type DashboardHandshake = z.infer<typeof handshakeSchema>
export type CardSummary = z.infer<typeof cardSummarySchema>
export type DomainEvent = z.infer<typeof domainEventSchema>
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>
export type EventPage = z.infer<typeof eventPageSchema>
export type PublicQuery = z.infer<typeof publicQuerySchema>
export type EventQuery = z.infer<typeof eventQuerySchema>

/** Read-only process-local lease. No browser identity, arbitrary patch, or final acceptance. */
export interface DashboardReadLease {
  handshake(): DashboardHandshake
  snapshot(): Promise<PublicSnapshot>
  events(after: number, limit?: number): Promise<EventPage>
  subscribe(listener: () => void): () => void
  close(): void
}
export interface DashboardExtensionService {
  /** Runtime also rejects a missing/API1 query: old consumers must explicitly upgrade. */
  connect(query: PublicQuery): DashboardReadLease
}
declare module '@deepseek-ai/cordis' { interface Context { sessionDashboardExtensions: DashboardExtensionService } }
