import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FacetChip, FacetRow, FacetRowsDetail, SessionFacetDescriptor } from '../shared/facets.js'
import { useDashboardLocale } from './i18n.js'
import { getPortalRenderer } from './portal.js'

/** The panel is a document-level overlay: project cards clip their own scroll
 *  container, so a fixed-position panel is measured from the chip and mounted
 *  through the host portal exactly like the status picker. */
const PANEL_WIDTH = 300
const PANEL_GAP = 6
const VIEWPORT_MARGIN = 8
/** Room the panel needs to be worth opening downward instead of upward. */
const PANEL_MIN_HEIGHT = 160
const PANEL_MAX_HEIGHT = 360

/** A press that dismisses a panel must not also activate whatever sits under the
 *  pointer. The project card folds itself on any click that is not on a button,
 *  so without this the press that closes a facet panel also collapses the card.
 *  The flag is armed on the dismissing pointerdown and spent on the click that
 *  follows; a press that produces no click (a drag) expires on its own. */
let swallowNextClick = false
let swallowTimer: ReturnType<typeof setTimeout> | null = null
function swallowFollowingClick(): void {
  swallowNextClick = true
  if (swallowTimer !== null) clearTimeout(swallowTimer)
  swallowTimer = setTimeout(() => { swallowNextClick = false; swallowTimer = null }, 500)
}
/** One capture listener per document. The handler is stored on the document
 *  itself, keyed by a registered symbol, so an HMR re-evaluation reuses it instead
 *  of adding a second capture listener; plugin dispose removes it explicitly. */
const SWALLOW_HANDLER = Symbol.for('dsh.session-dashboard.facet-click-swallow')
type SwallowDocument = Document & { [SWALLOW_HANDLER]?: (event: MouseEvent) => void }
function swallowClick(event: MouseEvent): void {
  if (!swallowNextClick) return
  swallowNextClick = false
  if (swallowTimer !== null) { clearTimeout(swallowTimer); swallowTimer = null }
  event.preventDefault()
  event.stopPropagation()
}
function installClickSwallow(doc: Document): void {
  const target = doc as SwallowDocument
  if (target[SWALLOW_HANDLER] !== undefined) return
  target[SWALLOW_HANDLER] = swallowClick
  doc.addEventListener('click', swallowClick, true)
}
/** Removes the page-wide capture listener (plugin dispose / tests). */
export function uninstallFacetClickSwallow(doc: Document): void {
  const target = doc as SwallowDocument
  const handler = target[SWALLOW_HANDLER]
  if (handler === undefined) return
  delete target[SWALLOW_HANDLER]
  doc.removeEventListener('click', handler, true)
  if (swallowTimer !== null) { clearTimeout(swallowTimer); swallowTimer = null }
  swallowNextClick = false
}

interface StripState { open: string | null; setOpen(id: string | null): void }
const StripContext = createContext<StripState | null>(null)

/** One row of facets belonging to a single Session. The host owns the layout,
 *  the one-open-at-a-time rule and the overflow behaviour, so a contribution
 *  never positions itself against the row. */
export function FacetStrip({ children, label }: { children?: ReactNode; label?: string }) {
  const [open, setOpenState] = useState<string | null>(null)
  const setOpen = useCallback((id: string | null) => setOpenState(id), [])
  const value = useMemo<StripState>(() => ({ open, setOpen }), [open, setOpen])
  if (children === undefined || children === null || children === false) return null
  return <span className="sd-facets" role="group" aria-label={label}>
    <StripContext.Provider value={value}>{children}</StripContext.Provider>
  </span>
}

/** Visible chip text, count included: `⛓ 2`, `☑ 1/3`, or a bare label. */
function chipText(chip: FacetChip): string {
  const parts: string[] = []
  if (chip.text !== undefined && chip.text !== '') parts.push(chip.text)
  if (chip.count !== undefined) parts.push(chip.total === undefined ? String(chip.count) : `${chip.count}/${chip.total}`)
  return parts.join(' ')
}

/** One declared facet: a chip plus the popover the host renders for it. A facet
 *  with neither `detail` nor `openDetails` is a read-only chip and is not a
 *  button, so it never becomes a dead control the reader can press. */
export function SessionFacet({ facet }: { facet: SessionFacetDescriptor }) {
  const { t } = useDashboardLocale()
  const strip = useContext(StripContext)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = strip === null ? ownOpen : strip.open === facet.id
  const chip = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const [detail, setDetail] = useState<FacetRowsDetail | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const panelId = useId()
  // Reading the latest descriptor keeps the loader from re-running when a parent
  // re-renders the row: only opening the panel is a load trigger.
  const detailRef = useRef(facet.detail)
  detailRef.current = facet.detail
  const interactive = facet.detail !== undefined || facet.openDetails !== undefined

  const toggle = (next: boolean) => {
    if (strip !== null) strip.setOpen(next ? facet.id : null)
    setOwnOpen(next)
  }
  const close = useCallback((focus: boolean) => {
    if (strip !== null) strip.setOpen(null)
    setOwnOpen(false)
    setAnchor(null)
    if (focus) chip.current?.focus()
  }, [strip?.setOpen])

  useEffect(() => {
    if (!open) { setAnchor(null); return }
    const node = chip.current
    if (node === null) return
    const box = node.getBoundingClientRect()
    const viewport = typeof window === 'undefined' ? PANEL_WIDTH + VIEWPORT_MARGIN * 2 : window.innerWidth
    const height = typeof window === 'undefined' ? 0 : window.innerHeight
    const left = Math.max(VIEWPORT_MARGIN, Math.min(box.left, viewport - PANEL_WIDTH - VIEWPORT_MARGIN))
    // Rows sit near the bottom of a long project list, so a panel that only opens
    // downward runs off the viewport. Flip above the chip whenever the room above
    // is the larger half, and always clamp the height to the space it got.
    const below = height - box.bottom - PANEL_GAP - VIEWPORT_MARGIN
    const above = box.top - PANEL_GAP - VIEWPORT_MARGIN
    const up = height > 0 && below < Math.min(PANEL_MIN_HEIGHT, above)
    setAnchor(up
      ? { left, bottom: height - box.top + PANEL_GAP, maxHeight: Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, above)) }
      : { left, top: box.bottom + PANEL_GAP, maxHeight: Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, below)) })
    const source = detailRef.current
    if (source === undefined) return
    if (typeof source !== 'function') { setDetail(source); setPhase('ready'); return }
    let cancelled = false
    setPhase('loading')
    source().then(value => { if (!cancelled) { setDetail(value); setPhase('ready') } }, () => { if (!cancelled) { setDetail(null); setPhase('failed') } })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    installClickSwallow(document)
    const away = (event: Event) => {
      const target = event.target as Node | null
      if (target === null) return
      if (chip.current?.contains(target) === true || panel.current?.contains(target) === true) return
      // A press on another control (a sibling chip, a row menu) is a real
      // activation: let that control act on its own click. Only a press on a
      // passive surface — the project card behind the panel — is swallowed.
      // Duck-typed on purpose: fixtures and unit-test globals do not always define
      // the global `Element` constructor this package is bundled against.
      const element = target as unknown as { closest?: (selector: string) => unknown }
      if (typeof element.closest === 'function' && element.closest('button, a, input, select, textarea, [role="button"]') !== null) { close(false); return }
      swallowFollowingClick()
      close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      close(true)
    }
    // A fixed panel cannot follow a scrolling row, so any scroll closes it.
    const drift = () => close(false)
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', drift, true)
    window.addEventListener('resize', drift)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('scroll', drift, true)
      window.removeEventListener('resize', drift)
    }
  }, [open, close])

  const label = facet.chip.title ?? chipText(facet.chip)
  const body = <>{facet.chip.icon !== undefined && <span className="sd-facet-icon" aria-hidden="true">{facet.chip.icon}</span>}
    {facet.chip.text !== undefined && facet.chip.text !== '' && <span className="sd-facet-text">{facet.chip.text}</span>}
    {facet.chip.count !== undefined && <b className="sd-facet-count">{facet.chip.total === undefined ? facet.chip.count : `${facet.chip.count}/${facet.chip.total}`}</b>}</>

  if (!interactive) return <span className="sd-facet" data-tone={facet.chip.tone ?? 'neutral'} title={label}>{body}</span>

  const panelNode = open && anchor !== null && facet.openDetails === undefined
    ? <div className="sd-facet-panel" id={panelId} ref={panel} role="group" aria-label={label} style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, maxHeight: anchor.maxHeight, width: PANEL_WIDTH }}>
      {phase === 'loading' && <p className="sd-facet-empty" role="status">{t('facetLoading')}</p>}
      {phase === 'failed' && <p className="sd-facet-empty" role="alert">{t('facetFailed')}</p>}
      {phase === 'ready' && detail !== null && <FacetRows detail={detail}/>}
    </div>
    : null
  const portal = getPortalRenderer()

  return <span className="sd-facet-wrap">
    <button type="button" ref={chip} className="sd-facet" data-tone={facet.chip.tone ?? 'neutral'} data-open={open ? 'true' : undefined}
      aria-label={label} aria-expanded={open} aria-haspopup="true" aria-controls={open ? panelId : undefined} title={label}
      onClick={() => {
        if (facet.openDetails !== undefined) { close(false); facet.openDetails(); return }
        toggle(!open)
      }}>{body}</button>
    {panelNode !== null && (portal === null ? panelNode : portal(panelNode, document.body))}
  </span>
}

/** Popover body: a flat list with optional nested rows (a subagent's own todos). */
function FacetRows({ detail }: { detail: FacetRowsDetail }) {
  const { t } = useDashboardLocale()
  if (detail.rows.length === 0) return <p className="sd-facet-empty" role="status">{detail.empty ?? t('facetEmpty')}</p>
  return <ul className="sd-facet-rows">{detail.rows.map(row => <FacetRowItem key={row.id} row={row}/>)}</ul>
}

function FacetRowItem({ row }: { row: FacetRow }) {
  return <li className="sd-facet-row" data-state={row.state ?? 'idle'}>
    <span className="sd-facet-dot" aria-hidden="true"/>
    <span className="sd-facet-rowbody">
      <span className="sd-facet-title" title={row.title}>{row.title}</span>
      {row.meta !== undefined && row.meta !== '' && <span className="sd-facet-meta">{row.meta}</span>}
      {row.children !== undefined && row.children.length > 0 && <ul className="sd-facet-rows sd-facet-children">{row.children.map(child => <FacetRowItem key={child.id} row={child}/>)}</ul>}
    </span>
  </li>
}
