/** Browser contribution contract; importing it never mounts the dashboard or a React root. */
export { dashboardChildren, withContributionBoundary } from './contribution.js'
/** Facet primitives for `session-dashboard.card.facet` contributions: declare a
 *  chip and its popover rows, and the host renders them like its own facets. */
export { FacetStrip, SessionFacet } from './facets.js'
export type { FacetChip, FacetRow, FacetRowState, FacetRowsDetail, FacetTone, SessionFacetDescriptor } from '../shared/facets.js'
export type { DashboardSlot, DashboardSlotContext, DashboardCardView, DashboardCardOwner, DashboardGlobalOwner, DashboardActions, DashboardSlots } from '../shared/slots.js'
