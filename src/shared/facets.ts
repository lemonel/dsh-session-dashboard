/** Row-level session facets: the small facts a session row shows beside its
 *  status, such as running subagents or open todos. A facet is data, not markup:
 *  the host owns the chip layout, the popover shell, focus handling and the
 *  single-open rule, so every contribution looks and behaves the same.
 *
 *  This module is React-free on purpose: the Host face, the browser face and
 *  third-party declarations all share these shapes without importing a renderer. */

/** Visual weight of one facet state, mapped to host colours. */
export type FacetTone = 'neutral' | 'business' | 'warn' | 'ok' | 'danger'

/** How one row inside a facet's popover stands. */
export type FacetRowState = 'running' | 'doing' | 'done' | 'pending' | 'failed' | 'idle'

/** One popover row: a subagent, a todo item, or a group that owns children.
 *  Titles are already display text; the host never re-derives them. */
export interface FacetRow {
  /** Stable identity inside this facet; only used as a React key and for tests. */
  id: string
  title: string
  /** Secondary text on the right: a state name, an elapsed time, `2/5`. */
  meta?: string
  state?: FacetRowState
  /** Nested rows, e.g. one subagent's own todo items. */
  children?: readonly FacetRow[]
}

/** The always-visible part: a chip with an optional count. */
export interface FacetChip {
  /** Short glyph before the label; a contribution's own icon, never an image URL. */
  icon?: string
  /** Visible label. Omitted when the facet is only a count. */
  text?: string
  /** Primary number, e.g. running subagents. */
  count?: number
  /** Denominator, e.g. `1/3` todos. Rendered after {@link count}. */
  total?: number
  tone?: FacetTone
  /** Accessible name and hover hint; defaults to the visible text. */
  title?: string
}

/** A plain list body. Detail is loaded only when the reader opens the panel. */
export interface FacetRowsDetail {
  kind: 'rows'
  rows: readonly FacetRow[]
  /** Shown instead of the list when there are no rows. */
  empty?: string
}

/** What one contribution declares. Everything here is optional except the chip,
 *  so a facet that only reports a number still renders through the same host. */
export interface SessionFacetDescriptor {
  /** Stable identity inside one strip; sibling facets must not repeat it. */
  id: string
  chip: FacetChip
  /** A ready list, or a loader the host runs on open only. Absent means the chip
   *  is not interactive: the reader gets the count but no panel. */
  detail?: FacetRowsDetail | (() => Promise<FacetRowsDetail>)
  /** Opening navigates instead of showing a panel; mutually exclusive with detail. */
  openDetails?: () => void
}
