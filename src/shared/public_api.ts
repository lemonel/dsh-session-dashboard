/** Stable readonly extension protocol. This entry starts no host service or browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import { DASHBOARD_API_VERSION } from './extension.js'
import type { DashboardReadLease } from './extension.js'

/** Cordis supplies the actual calling registration; a self-reported plugin ID
 * never grants authority. API1 consumers must upgrade, not receive lossy states. */
export function connectDashboard(ctx: Pick<Context, 'get'>): DashboardReadLease {
  const service = ctx.get('sessionDashboardExtensions')
  if (!service || typeof service.connect !== 'function') throw new Error('Dashboard extension service is unavailable')
  return service.connect({ apiVersion: DASHBOARD_API_VERSION })
}
export { DASHBOARD_API_VERSION, DOMAIN_EVENT_SCHEMA_VERSION, scopeSchema, handshakeSchema, publicSnapshotSchema, eventPageSchema, domainEventSchema, cardSummarySchema, publicQuerySchema, eventQuerySchema } from './extension.js'
export { placementSchema, episodeOriginSchema, statusSnapshotSchema, projectSnapshotSchema, projectSchema, statusLabelSchema } from './model.js'
export { historyRecordSchema, historyPageSchema } from './history.js'
export type { DashboardScope, DashboardHandshake, CardSummary, DomainEvent, PublicSnapshot, EventPage, PublicQuery, EventQuery, DashboardReadLease, DashboardExtensionService } from './extension.js'
export type { Placement, EpisodeOrigin, StateSnapshot, ProjectSnapshot, Project, StatusLabel } from './model.js'
export type { HistoryRecord, HistoryPage } from './history.js'
