import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardSummary, DashboardHandshake } from './extension.js'
import type { Entry } from './model.js'

export interface DashboardSlotContext {
  readonly handshake: DashboardHandshake | null
  readonly entry: Entry
  readonly projectId: string | null
  /** Unique visible sessions; tag-column references are not added together. */
  readonly uniqueVisible: number
}
export interface DashboardActions {
  /** Requests core navigation with current member/epoch and draft protection. */
  openDetails(): Promise<void>
  /** Opens the existing human review UI; never accepts a result. */
  requestReview(): Promise<void>
}
export interface DashboardGlobalOwner { readonly context: DashboardSlotContext }
export type DashboardCardView = Pick<CardSummary, 'sessionId' | 'membershipId' | 'title' | 'projectId' | 'tagIds' | 'projectTagIds' | 'effectiveTagIds' | 'status' | 'placement' | 'origin' | 'workflowRevision' | 'episodeId' | 'lifecycleRevision' | 'metadataRevision' | 'archived' | 'hostArchive' | 'attention' | 'sync' | 'sourceLive' | 'phase' | 'endedAt' | 'reviewAt' | 'turnEnd'> & {
  /** Null explicitly withdraws UI currency; it never grants execution authority. */
  readonly cancellationGeneration: number | null
}
export interface DashboardCardOwner extends DashboardGlobalOwner {
  readonly card: Readonly<DashboardCardView>
  /** UI state is occurrence-local; use scope/member/episode for entity caches. */
  readonly occurrenceId: string
  readonly actions: DashboardActions
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'session-dashboard.toolbar.action': { kind: 'list'; scope: 'root'; owner: DashboardGlobalOwner }
    'session-dashboard.summary.widget': { kind: 'list'; scope: 'root'; owner: DashboardGlobalOwner }
    'session-dashboard.card.badge': { kind: 'list'; scope: 'root'; owner: DashboardCardOwner }
    /** Row facets: the counts and popover rows a row shows beside its status. The
     *  host owns the chip layout, the panel shell and the single-open rule. */
    'session-dashboard.card.facet': { kind: 'list'; scope: 'root'; owner: DashboardCardOwner }
    'session-dashboard.card.menu.item': { kind: 'list'; scope: 'root'; owner: DashboardCardOwner }
    /** First version: read-only or inline recoverably self-persisted inputs; no arbitrary portal. */
    'session-dashboard.detail.section': { kind: 'list'; scope: 'root'; owner: DashboardCardOwner }
  }
}
export type DashboardSlot = 'session-dashboard.toolbar.action' | 'session-dashboard.summary.widget' | 'session-dashboard.card.badge' | 'session-dashboard.card.facet' | 'session-dashboard.card.menu.item' | 'session-dashboard.detail.section'
export type DashboardSlots = PropsRenderSlots<DashboardSlot>
