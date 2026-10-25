import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { EMPTY } from '../shared/model.js'
import type { Board, Card, Project, Snapshot } from '../shared/model.js'
import type { Command } from '../shared/commands.js'
import { ArchiveBadge } from './ArchiveBadge.js'
import type { DashboardClient } from './client.js'
import { useDashboardLocale, useTranslator } from './i18n.js'
import { Modal } from './Modal.js'
import { ColorField, validColor } from './ColorField.js'
import { NATIVE_SIDEBAR_DRAG_TYPE, parseNativeSidebarDrag } from './native-sidebar.js'
import { PROJECT_DRAG_TYPE, parseProjectDrag, type ProjectDrag } from './project-drag.js'
import { StateControl } from './StateControl.js'
import { useProjectTranslator } from './project-locales.js'
import { Popover } from './Popover.js'
import { SessionRowHead, type RowActionHandlers } from './RowActions.js'
import { attentionDetail, attentionLabel, attentionTone, effectiveTags, formatTime, needsAction, runningElapsedStart, statusActivityOrder, statusBucketLabel, terminalOutcome, valueText } from './view-model.js'
import { FilterSelector, STATUS_DIMENSION, matchesFilter, selectedCount, type FilterSelections } from './FilterSelector.js'
import { RunningElapsed } from './Elapsed.js'

export interface PendingProjectJoin { token: string; sessionId: string; projectId: string; title: string; phase: 'joining' | 'confirming' }
interface OverviewProps {
  board: Board
  /** Optional session-details entry point; without it a session row opens that project's board. */
  onOpenSession?: (card: Card) => void
  /** Optional read-only conversation preview; without it a session row falls back to details. */
  onPreviewSession?: (card: Card) => void
  onJoin: (source: ProjectDrag, projectId: string | null) => void
  onCreate: () => void
  /** Create a blank Host Session and join it here; absent when the host offers no creation path. */
  onNewSession?: (projectId: string) => void
  /** Host-owned facet strip for one session row: built-in facets plus contributions. */
  facets?: (card: Card) => ReactNode
  /** Contributions registered for a card: a badge inside the row and extra menu entries. */
  extensions?: { badge?: (card: Card, occurrence: string) => ReactNode; menu?: (card: Card, occurrence: string) => ReactNode }
  /** One creation at a time; the menu entry stays visible but disabled. */
  newSessionBusy?: boolean
  onEdit: (projectId: string) => void
  onDelete: (project: Project) => void
  /** The board order list is the single source of truth for project display order. */
  onReorder: (ids: string[]) => void
  onChangeState?: (card: Card, stateId: string | null) => void | Promise<void>
  /** Pending-review sessions move through the acceptance dialog, not choose_state. */
  onReviewState?: (card: Card, stateId: string | null) => void | Promise<void>
  /** Optimistic session additions for this render, keyed by target project. */
  pendingJoins?: PendingProjectJoin[]
  /** Opens the tag manager (groups and their values). */
  onManageTags?: () => void
  /** Rename / fork / archive a session from its row. */
  rowActions?: RowActionHandlers
}
const TILE_WIDTH = 340, ROW_GAP = 8, ROW_RAIL = 20, ROW_END_RAIL = 18
type RowTile = { kind: 'project'; project: Project } | { kind: 'ghost' }
interface ProjectDragState { id: string; startX: number; startY: number; x: number; y: number; active: boolean; cancel: boolean; previewIds: string[] | null }
const DRAG_THRESHOLD = 5
/** Drop-side detection happens inside the card header, not the tall expanded panel. */
const EDGE_ZONE = 64
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index])
/** One session inside a project's dropdown: compact, readable at panel width. The
 *  title owns the preview entry point; details live behind the row's own menu. */
function ProjectSessionRow({ board, card, onPreview, onChangeState, onReviewState, actions, facets, badge, menu }: { board: Board; card: Card; onPreview: (card: Card) => void; onChangeState?: (card: Card, statusId: string | null) => void | Promise<void>; onReviewState?: (card: Card, statusId: string | null) => void | Promise<void>; actions?: RowActionHandlers; facets?: (card: Card) => ReactNode; badge?: (card: Card, occurrence: string) => ReactNode; menu?: (card: Card, occurrence: string) => ReactNode }) {
  const { t, active } = useDashboardLocale(), tags = effectiveTags(board, card)
  // The row hides the chip's own label to keep 128px, so the concrete system outcome
  // (interrupted / failed / stopped) gets its own short visible label here.
  // A terminal system result is already the chip's own text, so the row does not
  // repeat it; other attention (input/approval/resume/sync) still gets its label.
  const mark = terminalOutcome(card) === null ? attentionLabel(card, t) : null, markDetail = attentionDetail(card, t)
  const elapsedStart = runningElapsedStart(card), rowTime = formatTime(card.activityAt ?? card.joinedAt, active, t)
  return <article className="sd-projectrow" data-card-id={card.sessionId}>
    <SessionRowHead card={card} titleClassName="sd-projectrow-title" onOpen={() => onPreview(card)} actions={actions}/>
    <div className="sd-row sd-small sd-muted">
      <StateControl board={board} card={card} onChangeState={onChangeState} onReviewState={onReviewState} />{mark && <span className="sd-attentioninline" data-tone={attentionTone(card) ?? undefined} title={t('attentionMarkTitle', { reason: markDetail ?? mark })}>{mark}</span>}{facets?.(card)}{badge?.(card, `row:${card.membershipId}`)}
      <span>· {elapsedStart === null ? rowTime : <RunningElapsed startedAt={elapsedStart} text={time => t('elapsedRunning', { time })} title={t('elapsedHint', { start: formatTime(elapsedStart, active, t), last: rowTime })}/>}</span>
    </div>
    {card.progress && <p className="sd-small sd-muted sd-projectrow-progress">{card.progress}</p>}
    <div className="sd-row"><ArchiveBadge value={card.hostArchive}/>{tags.slice(0, 3).map(id => <span className="sd-tag" key={id}>{valueText(board, 'tag', id, t)}</span>)}{tags.length > 3 && <span className="sd-small sd-muted">+{tags.length - 3}</span>}{menu?.(card, `row:${card.membershipId}`)}</div>
  </article>
}
function dragSource(event: DragEvent): ProjectDrag | null {
  if (event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return parseProjectDrag(event.dataTransfer.getData(PROJECT_DRAG_TYPE))
  if (!event.dataTransfer.types.includes(NATIVE_SIDEBAR_DRAG_TYPE)) return null
  const source = parseNativeSidebarDrag(event.dataTransfer.getData(NATIVE_SIDEBAR_DRAG_TYPE))
  return source ? { kind: 'sidebar', sessionId: source.sessionId, displayTitle: source.displayTitle } : null
}

/* Per-row height of the expanded Session area. Rows are a layout result, not
 * durable data, so their sizes stay in this browser instead of the board. */
const ROW_HEIGHTS_KEY = 'session-dashboard.row-heights'
const ROW_DEFAULT_HEIGHT = 300
const ROW_MIN_HEIGHT = 160
const ROW_MAX_HEIGHT = 900
function rowStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}
function readRowHeights(): Record<string, number> {
  const store = rowStorage()
  if (store === null) return {}
  try {
    const raw = store.getItem(ROW_HEIGHTS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const heights: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'number' && Number.isFinite(value)) heights[key] = clampRowHeight(value)
    return heights
  } catch { return {} }
}
function writeRowHeights(heights: Record<string, number>): void {
  const store = rowStorage()
  if (store === null) return
  try { store.setItem(ROW_HEIGHTS_KEY, JSON.stringify(heights)) } catch { /* storage unavailable */ }
}
function clampRowHeight(value: number): number { return Math.round(Math.min(ROW_MAX_HEIGHT, Math.max(ROW_MIN_HEIGHT, value))) }
/** 未归属 and 已归档 used to be tabs of their own. They are two small populations,
 *  so they sit under the project grid as collapsed sections: no second nav, and
 *  both are still one click away (a card drop files an unassigned session). */
function SessionBucket({ bucket, title, hint, cards, board, onPreview, onChangeState, onReviewState, actions, facets, badge, menu }: {
  bucket: 'unassigned' | 'archive'
  title: string
  hint?: string
  cards: Card[]
  board: Board
  onPreview: (card: Card) => void
  onChangeState?: (card: Card, stateId: string | null) => void | Promise<void>
  onReviewState?: (card: Card, stateId: string | null) => void | Promise<void>
  actions?: RowActionHandlers
  facets?: (card: Card) => ReactNode
  badge?: (card: Card, occurrence: string) => ReactNode
  menu?: (card: Card, occurrence: string) => ReactNode
}) {
  const t = useTranslator()
  const [open, setOpen] = useState(false)
  if (cards.length === 0) return null
  const regionId = `sd-bucket-${bucket}`
  return <section className="sd-bucket" data-bucket={bucket} aria-label={title}>
    <div className="sd-buckethead">
      <button type="button" className="sd-buckettoggle" aria-expanded={open} aria-controls={open ? regionId : undefined} onClick={() => setOpen(value => !value)}>
        <span className="sd-bucketcaret" aria-hidden="true">▸</span><b>{title}</b><span className="sd-small sd-muted">{t('bucketCount', { count: cards.length })}</span>
      </button>
      {hint !== undefined && <span className="sd-small sd-muted">{hint}</span>}
    </div>
    {open && <div className="sd-projectdrop-list" id={regionId}>
      {cards.map(card => <ProjectSessionRow key={card.membershipId} board={board} card={card} onPreview={onPreview} onChangeState={onChangeState} onReviewState={onReviewState} actions={actions} facets={facets} badge={badge} menu={menu}/>)}
    </div>}
  </section>
}
export function ProjectOverview({ board, onOpenSession, onPreviewSession, onJoin, onCreate, onNewSession, newSessionBusy, onEdit, onDelete, onReorder, onChangeState, onReviewState, pendingJoins = [], onManageTags, rowActions, facets, extensions }: OverviewProps) {
  const t = useTranslator()
  const [over, setOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [selections, setSelections] = useState<FilterSelections>({})
  const [columns, setColumns] = useState(1)
  const [drag, setDrag] = useState<ProjectDragState | null>(null)
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>(readRowHeights)
  const heightsRef = useRef(heights); heightsRef.current = heights
  const resizeRef = useRef<{ key: string; y: number; height: number } | null>(null)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const grid = useRef<HTMLDivElement>(null)
  const cancelZone = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ProjectDragState | null>(null)
  const pendingGripFocus = useRef<string | null>(null)
  const positions = useRef(new Map<string, { left: number; top: number }>())
  const lastOrder = useRef('')
  const orderedIds = board.orders.project.ids
  const orderRef = useRef(orderedIds); orderRef.current = orderedIds
  const effectiveIds = drag?.previewIds ?? pendingOrder ?? orderedIds
  const orderedProjects = [...board.projects].sort((a, b) => {
    const ai = effectiveIds.indexOf(a.id), bi = effectiveIds.indexOf(b.id)
    return (ai < 0 ? effectiveIds.length : ai) - (bi < 0 ? effectiveIds.length : bi)
  })
  // Configured status order first, newest activity first inside one status; the roster is the only flat list mixing statuses.
  // The selector and this pass share matchesFilter, so a visible row can never
  // disagree with the chip that selected it.
  const members = new Map(orderedProjects.map(project => [project.id, statusActivityOrder(board, [...new Map(board.cards.filter(card => card.projectId === project.id && card.archivedAt === null && matchesFilter(board, card, selections)).map(card => [card.sessionId, card])).values()])]))
  // Filters are a view, not a stored preference: keep only projects that still
  // have a visible session and hide the create-a-project ghost card.
  const filtering = selectedCount(selections) > 0
  const projects = filtering ? orderedProjects.filter(project => (members.get(project.id)?.length ?? 0) > 0) : orderedProjects
  const isOpen = (project: Project) => !collapsed.includes(project.id)
  const toggle = (project: Project) => setCollapsed(current => current.includes(project.id) ? current.filter(value => value !== project.id) : [...current, project.id])
  const collapse = (project: Project) => {
    setCollapsed(current => current.includes(project.id) ? current : [...current, project.id])
    triggers.current.get(project.id)?.focus({ preventScroll: true })
  }
  const setRowOpen = (rowProjects: Project[], open: boolean) => setCollapsed(current => {
    const ids = new Set(rowProjects.map(project => project.id))
    return open ? current.filter(id => !ids.has(id)) : [...new Set([...current, ...ids])]
  })
  /** Row height is presentation, so it is local: a keyboard arrow or a vertical
   *  drag on the right rail resizes just this row's expanded Session area. */
  const setRowHeight = (key: string, value: number) => {
    const next = { ...heightsRef.current, [key]: clampRowHeight(value) }
    heightsRef.current = next
    setHeights(next)
  }
  const startRowResize = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { key, y: event.clientY, height: heightsRef.current[key] ?? ROW_DEFAULT_HEIGHT }
  }
  const moveRowResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resizeRef.current
    if (state === null) return
    setRowHeight(state.key, state.height + event.clientY - state.y)
  }
  const endRowResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current === null) return
    resizeRef.current = null
    if (typeof event.currentTarget.hasPointerCapture === 'function' && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    writeRowHeights(heightsRef.current)
  }
  const nudgeRowHeight = (key: string, delta: number) => {
    setRowHeight(key, (heightsRef.current[key] ?? ROW_DEFAULT_HEIGHT) + delta)
    writeRowHeights(heightsRef.current)
  }
  useEffect(() => { setCollapsed(current => current.filter(id => board.projects.some(project => project.id === id))) }, [board.projects])
  // Explicit row groups make the row control and row-scoped drag feedback possible while the
  // cards themselves keep their fixed 340px width. Widths are measured, never inferred from CSS.
  useLayoutEffect(() => {
    const node = grid.current
    if (!node) return
    const measure = () => {
      const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches
      const usable = Math.max(0, node.clientWidth - ROW_RAIL - ROW_END_RAIL - ROW_GAP * 2)
      const next = narrow || usable < TILE_WIDTH ? 1 : Math.max(1, Math.floor((usable + ROW_GAP) / (TILE_WIDTH + ROW_GAP)))
      setColumns(current => current === next ? current : next)
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  const anyExpanded = projects.some(isOpen)
  const orderKey = projects.map(project => project.id).join('|')
  // FLIP: capture layout positions before the DOM paints the new order, then replay the
  // delta on the new nodes so previews and keyboard moves read as movement, not jumps.
  useLayoutEffect(() => {
    const node = grid.current
    if (!node) return
    const layout = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      let left = rect.left, top = rect.top
      const running = typeof element.getAnimations === 'function' ? element.getAnimations() : []
      if (running.length > 0 && typeof DOMMatrixReadOnly !== 'undefined') {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        left -= matrix.m41; top -= matrix.m42
      }
      return { left, top }
    }
    const current = new Map<string, { position: { left: number; top: number }; element: HTMLElement }>()
    for (const element of node.querySelectorAll<HTMLElement>('[data-project-id], .sd-ghostcard')) {
      current.set(element.dataset.projectId ?? 'ghost', { position: layout(element), element })
    }
    const previous = positions.current, changed = orderKey !== lastOrder.current
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (changed && previous.size > 0 && !reduce) for (const [key, { position, element }] of current) {
      const before = previous.get(key)
      if (!before) continue
      const dx = before.left - position.left, dy = before.top - position.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      if (typeof element.animate !== 'function') continue
      if (typeof element.getAnimations === 'function') for (const animation of element.getAnimations()) animation.cancel()
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 200, easing: 'cubic-bezier(.2,.75,.2,1)' })
    }
    positions.current = new Map([...current].map(([key, { position }]) => [key, position]))
    lastOrder.current = orderKey
  })
  const tiles: RowTile[] = [...projects.map(project => ({ kind: 'project' as const, project })), ...(filtering ? [] : [{ kind: 'ghost' as const }])]
  const rows: RowTile[][] = []
  for (let index = 0; index < tiles.length; index += columns) rows.push(tiles.slice(index, index + columns))
  const reorderedIds = (base: readonly string[], movedId: string, targetId: string, edge: 'before' | 'after'): string[] | null => {
    if (movedId === targetId) return null
    const ids = base.filter(id => id !== movedId)
    const at = ids.indexOf(targetId)
    if (at < 0) return null
    ids.splice(edge === 'before' ? at : at + 1, 0, movedId)
    // The unassigned sentinel stays last so new projects keep appending before it.
    const sentinel = ids.filter(id => id === EMPTY)
    return [...ids.filter(id => id !== EMPTY), ...sentinel]
  }
  const targetCard = (x: number, y: number, draggedId: string): { id: string; edge: 'before' | 'after' } | null => {
    const node = grid.current
    if (!node) return null
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-project-id]')
    if (hit && node.contains(hit) && hit.dataset.projectId) {
      if (hit.dataset.projectId === draggedId) return null
      const rect = hit.getBoundingClientRect()
      return { id: hit.dataset.projectId, edge: y < rect.top + Math.min(rect.height, EDGE_ZONE) / 2 ? 'before' : 'after' }
    }
    // Gaps between tiles still resolve to the nearest tile so long drags stay predictable.
    let bestId: string | null = null, bestRect: DOMRect | null = null, distance = 96
    for (const item of node.querySelectorAll<HTMLElement>('[data-project-id]')) {
      const id = item.dataset.projectId
      if (!id || id === draggedId) continue
      const rect = item.getBoundingClientRect()
      const dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom)
      const value = Math.hypot(dx, dy)
      if (value < distance) { distance = value; bestId = id; bestRect = rect }
    }
    if (!bestId || !bestRect) return null
    return { id: bestId, edge: y < bestRect.top + Math.min(bestRect.height, EDGE_ZONE) / 2 ? 'before' : 'after' }
  }
  const updateDrag = (next: ProjectDragState | null) => { dragRef.current = next; setDrag(next) }
  useEffect(() => {
    const pending = pendingOrder
    if (!pending) return
    if (sameIds(pending, orderedIds)) { setPendingOrder(null); return }
    const timer = setTimeout(() => setPendingOrder(null), 2500)
    return () => clearTimeout(timer)
  }, [pendingOrder, orderedIds])
  const dragActive = drag !== null, dragId = drag?.id
  useEffect(() => {
    if (!dragActive) return
    const finish = (commit: boolean) => {
      const current = dragRef.current
      updateDrag(null)
      if (!current?.active) return
      if (!commit || current.cancel || !current.previewIds) return
      const rect = grid.current?.getBoundingClientRect()
      if (!rect || current.x < rect.left || current.x > rect.right || current.y < rect.top || current.y > rect.bottom) return
      if (sameIds(current.previewIds, orderRef.current)) return
      setPendingOrder(current.previewIds)
      onReorder(current.previewIds)
    }
    const move = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current) return
      const x = event.clientX, y = event.clientY
      if (!current.active && Math.hypot(x - current.startX, y - current.startY) < DRAG_THRESHOLD) { updateDrag({ ...current, x, y }); return }
      const zone = cancelZone.current?.getBoundingClientRect()
      const cancel = Boolean(zone && x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom)
      if (cancel) { updateDrag({ ...current, x, y, active: true, cancel: true, previewIds: null }); return }
      let previewIds = current.previewIds
      const target = targetCard(x, y, current.id)
      if (target) {
        const next = reorderedIds(current.previewIds ?? orderRef.current, current.id, target.id, target.edge)
        if (next) previewIds = next
      }
      updateDrag({ ...current, x, y, active: true, cancel: false, previewIds })
      const scroller = grid.current?.closest('.sd-scroll')
      if (scroller instanceof HTMLElement) {
        const rect = scroller.getBoundingClientRect()
        if (x >= rect.left && x <= rect.right) {
          if (y < rect.top + 56) scroller.scrollTop -= 22
          else if (y > rect.bottom - 56) scroller.scrollTop += 22
        }
      }
    }
    const up = () => finish(true)
    const abort = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finish(false) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', abort)
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', abort)
      document.body.style.userSelect = ''
    }
  }, [dragActive, dragId])
  const startOrderDrag = (project: Project, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragRef.current) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    setPendingOrder(null)
    updateDrag({ id: project.id, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, cancel: false, previewIds: null })
  }
  const nudgeProject = (project: Project, offset: -1 | 1) => {
    // Move relative to the next project the reader can actually see, then splice
    // that neighbor relationship into the full order so hidden projects keep
    // their positions instead of being crossed silently.
    const displayed = projects.map(value => value.id)
    const index = displayed.indexOf(project.id), neighbor = displayed[index + offset]
    if (index < 0 || neighbor === undefined) return
    const full = orderedIds.filter(id => id !== EMPTY && id !== project.id)
    const at = full.indexOf(neighbor)
    if (at < 0) return
    full.splice(offset < 0 ? at : at + 1, 0, project.id)
    pendingGripFocus.current = project.id
    onReorder(orderedIds.includes(EMPTY) ? [...full, EMPTY] : full)
  }
  useLayoutEffect(() => {
    const id = pendingGripFocus.current
    if (!id) return
    const grip = grid.current?.querySelector<HTMLElement>(`[data-project-id="${id}"] .sd-projectcard-head .sd-projectgrip`)
    if (!grip) return
    pendingGripFocus.current = null
    grip.focus({ preventScroll: true })
  }, [board.orders.project.ids])
  const dropProject = (event: DragEvent, projectId: string) => {
    const recognized = event.dataTransfer.types.includes(PROJECT_DRAG_TYPE) || event.dataTransfer.types.includes(NATIVE_SIDEBAR_DRAG_TYPE)
    if (!recognized) return
    event.preventDefault(); event.stopPropagation(); setOver(null)
    setCollapsed(current => current.filter(id => id !== projectId))
    const source = dragSource(event)
    if (source) onJoin(source, projectId)
  }
  const card = (project: Project) => {
    const roster = members.get(project.id) ?? []
    const joining = pendingJoins.filter(join => join.projectId === project.id)
    const reviews = roster.filter(row => row.placement.kind === 'builtin' && row.placement.status === 'pending_review').length
    const attention = roster.filter(needsAction).length
    const open = isOpen(project), regionId = `sd-project-sessions-${project.id}`
    const previewSession = (row: Card) => { if (onPreviewSession) onPreviewSession(row); else if (onOpenSession) onOpenSession(row) }
    return <article key={project.id} className="sd-projectcard" aria-label={project.name} data-project-id={project.id} data-expanded={open ? 'true' : undefined} data-over={over === project.id ? 'true' : undefined}
      data-dragging={drag?.id === project.id ? 'true' : undefined}
      onClick={event => { const target = event.target as HTMLElement; /* A facet chip is a plain span when it has no rows to open, and its panel can be inline when the host offers no portal: neither is part of the card's own click surface. */ if (target.closest('button') || target.closest('.sd-pop') || target.closest('.sd-statepanel') || target.closest('.sd-projectdrop') || target.closest('.sd-facet') || target.closest('.sd-facet-wrap') || target.closest('.sd-facet-panel')) return; toggle(project) }}
      onDragOver={event => { if (event.dataTransfer.types.includes(PROJECT_DRAG_TYPE) || event.dataTransfer.types.includes(NATIVE_SIDEBAR_DRAG_TYPE)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes(NATIVE_SIDEBAR_DRAG_TYPE) || event.dataTransfer.effectAllowed === 'copy' ? 'copy' : 'move'; setOver(project.id) } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setOver(null) }}
      onDrop={event => dropProject(event, project.id)}>
      <div className="sd-projectcard-head">
        <button type="button" className="sd-projectgrip" aria-label={t('reorderProject', { name: project.name })} title={t('reorderProject', { name: project.name })}
          onPointerDown={event => startOrderDrag(project, event)}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return
            event.preventDefault(); event.stopPropagation(); nudgeProject(project, event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)
          }}><span aria-hidden="true">⠿</span></button>
        <h3>
          <button type="button" ref={node => { if (node) triggers.current.set(project.id, node); else triggers.current.delete(project.id) }} className="sd-projecttoggle" aria-expanded={open} aria-controls={regionId} title={project.name} onClick={() => toggle(project)}>
            <span className="sd-projecttoggle-caret" aria-hidden="true">▸</span>
            {project.color && <span className="sd-dot" style={{ background: project.color }} aria-hidden="true"/>}
            <span className="sd-projectname">{project.name}</span>
          </button>
        </h3>
        <p className="sd-projectstats"><b>{t('membersCount', { count: roster.length })}</b><b>{t('reviewCount', { count: reviews })}</b><b>{t('attentionCount', { count: attention })}</b></p>
        <Popover label={t('projectActions', { name: project.name })} closeOnSelect>
          {onNewSession && <button className="sd-menu-item" disabled={newSessionBusy} onClick={() => onNewSession(project.id)}>{t('newSession')}</button>}
          <button className="sd-menu-item" onClick={() => onEdit(project.id)}>{t('editProject')}</button>
          <button className="sd-menu-item sd-danger" onClick={() => onDelete(project)}>{t('deleteProject')}</button>
        </Popover>
      </div>
      {open && <div className="sd-projectdrop" id={regionId} role="region" aria-label={`${project.name} · ${t('membersCount', { count: roster.length })}`} tabIndex={-1} data-project-drop={project.id}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); collapse(project) } }}>
        <div className="sd-projectdrop-list">{joining.map(join => <div className="sd-projectrow sd-projectrow-pending" key={join.token} role="status" aria-busy="true"><span className="sd-projectrow-title">{join.title}</span><span className="sd-small sd-muted">{t(join.phase === 'confirming' ? 'confirmingJoin' : 'joiningProject')}</span></div>)}{roster.length ? roster.map(row => <ProjectSessionRow key={row.membershipId} board={board} card={row} onPreview={previewSession} onChangeState={onChangeState} onReviewState={onReviewState} actions={rowActions} facets={facets} badge={extensions?.badge} menu={extensions?.menu}/>) : joining.length === 0 ? <p className="sd-small sd-muted sd-projectdrop-empty">{t('noMembers')}</p> : null}</div>
        {project.tagIds.length > 0 && <div className="sd-projectdrop-foot"><span className="sd-row sd-projectdrop-tags" aria-label={t('publicTags')}>{project.tagIds.slice(0, 2).map(id => { const tag = board.tags.find(value => value.id === id); return tag ? <span key={id} className="sd-tag">{tag.name}</span> : null })}{project.tagIds.length > 2 && <span className="sd-small sd-muted">+{project.tagIds.length - 2}</span>}</span></div>}
      </div>}
    </article>
  }
  // Newest first, and archived cards stay out of the unassigned bucket: one card
  // belongs to exactly one of the two.
  const byActivity = (left: Card, right: Card) => (right.activityAt ?? right.joinedAt) - (left.activityAt ?? left.joinedAt)
  // The same selection narrows the two bottom buckets, so a tag or status filter is
  // a view of every session list, not just the project cards.
  const unassignedCards = board.cards.filter(card => card.projectId === null && card.archivedAt === null && (!filtering || matchesFilter(board, card, selections))).sort(byActivity)
  const archivedCards = board.cards.filter(card => card.archivedAt !== null && (!filtering || matchesFilter(board, card, selections))).sort(byActivity)
  /** A status-only selection keeps the precise old sentence; any wider selection
   *  reports how many values are narrowing the grid. */
  const selected = Object.entries(selections).filter(([, ids]) => ids.length > 0)
  const singleStatus = selected.length === 1 && selected[0][0] === STATUS_DIMENSION && selected[0][1].length === 1 ? selected[0][1][0] : null
  const filterHint = !filtering ? t('projectGridHint') : singleStatus === null
    ? t('filterApplied', { count: selectedCount(selections) })
    : t('statusFilterHint', { name: statusBucketLabel(board, singleStatus, t) })
  const clearSelectionFilter = () => {
    setSelections({})
    // The clear control unmounts with the empty state; return focus to the first
    // restored project once React has committed the unfiltered grid.
    setTimeout(() => grid.current?.querySelector<HTMLElement>('.sd-projectcard .sd-projecttoggle')?.focus({ preventScroll: true }), 0)
  }
  return <section className="sd-stack" aria-label={t('projectsHome')}>
    <div className="sd-between sd-overviewhead"><h2>{t('projectsHome')}</h2>
      <FilterSelector board={board} cards={board.cards} selections={selections} onChange={setSelections} onManageTags={onManageTags}/>
    </div>
    {(filtering || projects.length > 0) && <p className="sd-small sd-muted sd-projecthint" role="status">{filterHint}</p>}
    {!projects.length && (filtering
      ? unassignedCards.length === 0 && archivedCards.length === 0 && <div className="sd-empty sd-stack"><h3 aria-live="polite">{t('noStatusFilterMatches')}</h3><p>{t('noStatusFilterHint')}</p><button type="button" className="sd-small" onClick={clearSelectionFilter}>{t('clearFiltersEmpty')}</button></div>
      : board.projects.length === 0 && <div className="sd-empty sd-stack"><h3>{t('noProjects')}</h3><p>{t('noProjectsHint')}</p></div>)}
    <div className="sd-projectgrid" ref={grid}>
      {rows.map((row, index) => {
        const rowProjects = row.flatMap(tile => tile.kind === 'project' ? [tile.project] : [])
        const allOpen = rowProjects.length > 0 && rowProjects.every(isOpen)
        const rowKey = rowProjects.length > 0 ? rowProjects.map(project => project.id).join('|') : 'ghost'
        const rowHeight = heights[rowKey]
        return <div className={rowProjects.length > 0 ? 'sd-projectgroup sd-projectgroup-ruled' : 'sd-projectgroup'} key={rowKey} data-project-row={index} data-row-height={rowHeight}
          style={rowHeight === undefined ? undefined : { '--sd-row-drop-height': `${rowHeight}px` } as CSSProperties}>
          <div className="sd-projectgroup-rail">{rowProjects.length > 0 && <button type="button" className="sd-projectgroup-toggle" aria-expanded={allOpen}
            aria-label={t(allOpen ? 'collapseRow' : 'expandRow', { count: rowProjects.length })} title={t(allOpen ? 'collapseRow' : 'expandRow', { count: rowProjects.length })}
            onClick={() => setRowOpen(rowProjects, !allOpen)}><span className="sd-projectgroup-caret" aria-hidden="true">▸</span></button>}</div>
          <div className="sd-projectgroup-cards">{row.map(tile => tile.kind === 'project' ? card(tile.project) : <button key="ghost" type="button" className="sd-ghostcard" data-expanded={rowProjects.length === 0 && anyExpanded ? 'true' : undefined} aria-label={t('newProject')} onClick={onCreate}><span className="sd-plus" aria-hidden="true">+</span><span>{t('newProject')}</span></button>)}</div>
          {rowProjects.length > 0 && <div className="sd-projectgroup-rail sd-projectgroup-rail-end">
            <button type="button" className="sd-projectgroup-resize" aria-label={t('resizeRow')} title={t('resizeRow')}
              onPointerDown={event => startRowResize(rowKey, event)} onPointerMove={moveRowResize}
              onPointerUp={endRowResize} onPointerCancel={endRowResize}
              onKeyDown={event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault(); event.stopPropagation()
                nudgeRowHeight(rowKey, event.key === 'ArrowDown' ? 24 : -24)
              }}><span aria-hidden="true">⠿</span></button>
          </div>}
        </div>
      })}
    </div>
    <SessionBucket bucket="unassigned" title={t('unassignedBucket')} hint={t('bucketHint')} cards={unassignedCards} board={board} onPreview={card => { if (onPreviewSession) onPreviewSession(card); else if (onOpenSession) onOpenSession(card) }} onChangeState={onChangeState} onReviewState={onReviewState} actions={rowActions} facets={facets} badge={extensions?.badge} menu={extensions?.menu}/>
    <SessionBucket bucket="archive" title={t('archiveBucket')} cards={archivedCards} board={board} onPreview={card => { if (onPreviewSession) onPreviewSession(card); else if (onOpenSession) onOpenSession(card) }} onChangeState={onChangeState} onReviewState={onReviewState} actions={rowActions} facets={facets} badge={extensions?.badge} menu={extensions?.menu}/>
    {drag?.active && <div ref={cancelZone} className="sd-projectcancel" data-active={drag.cancel ? 'true' : undefined}>
      <span className="sd-projectcancel-icon" aria-hidden="true">×</span>
      <span>{t('cancelDrop')}</span>
    </div>}
    {drag?.active && <div className="sd-projectdragchip" data-cancel={drag.cancel ? 'true' : undefined} style={{ left: drag.x + 14, top: drag.y + 14 }}>{drag.cancel ? t('cancelDropShort') : (projects.find(project => project.id === drag.id)?.name ?? '')}</div>}
  </section>
}
interface DialogProps { board: Board; client: DashboardClient; projectId: string | null; busy: boolean; onClose: () => void }
interface ProjectForm { name: string; color: string; tagIds: string[]; revision: number; original: string }
const projectValue = (form: Pick<ProjectForm, 'name' | 'color' | 'tagIds'>) => JSON.stringify([form.name, form.color, [...form.tagIds].sort()])
const projectFormOf = (project?: Project): ProjectForm => {
  const form = { name: project?.name ?? '', color: project?.color ?? '', tagIds: [...(project?.tagIds ?? [])], revision: project?.revision ?? 0 }
  return { ...form, original: projectValue(form) }
}
export function ProjectDialog(props: DialogProps) { return <ProjectEditor key={props.projectId ?? '__new__'} {...props}/> }
function ProjectEditor({ board, client, projectId, busy, onClose }: DialogProps) {
  const t = useTranslator(), pt = useProjectTranslator()
  const project = board.projects.find(value => value.id === projectId)
  const [form, setForm] = useState(() => projectFormOf(project))
  const [tagName, setTagName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [pending, setPending] = useState(false)
  const alive = useRef(true), locked = useRef(false)
  const openedServiceId = useRef(client.serviceId)
  const projectDirty = projectValue(form) !== form.original
  const dirty = projectDirty || tagName.trim().length > 0
  const working = busy || pending
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  const execute = async (command: Command): Promise<Snapshot | null> => {
    if (working || locked.current) return null
    if (!openedServiceId.current || client.serviceId !== openedServiceId.current) { setMessage(pt('serviceExpired')); return null }
    locked.current = true; setPending(true); setMessage(null)
    try {
      const result = await client.mutate(command)
      if (!alive.current) return null
      if (client.serviceId !== openedServiceId.current) { setMessage(pt('serviceExpired')); return null }
      if (!result) { setMessage(pt('requestFailed')); return null }
      setMessage(t('saved'))
      return result
    } catch { if (alive.current) setMessage(pt('requestFailed')); return null }
    finally { locked.current = false; if (alive.current) setPending(false) }
  }
  const saveProject = async () => {
    if (!form.name.trim() || working) return
    if (tagName.trim()) { setMessage(pt('pendingTag')); return }
    if (!validColor(form.color)) { setMessage(pt('colorInvalid')); return }
    const fields = { name: form.name, color: form.color || null, tagIds: form.tagIds }
    const result = await execute(projectId === null ? { type: 'create_project', ...fields } : { type: 'update_project', projectId, expectedProjectRevision: form.revision, ...fields })
    if (!result || !alive.current) return
    if (projectId === null) { onClose(); return }
    const saved = result.board.projects.find(value => value.id === projectId)
    if (saved) setForm(projectFormOf(saved))
  }
  const createTag = async () => {
    if (!tagName.trim() || working) return
    const oldIds = new Set(board.tags.map(value => value.id))
    const result = await execute({ type: 'create_label', dimension: 'tag', name: tagName, color: null })
    if (!result || !alive.current) return
    const created = result.board.tags.find(value => !oldIds.has(value.id) && value.name === tagName.trim())
    if (created) { setForm(value => ({ ...value, tagIds: [...new Set([...value.tagIds, created.id])] })); setTagName('') }
  }
  const close = () => { if (dirty) setClosing(true); else onClose() }
  const stale = project !== undefined && form.revision !== project.revision
  return <Modal title={t(projectId === null ? 'newProject' : 'editProject')} onClose={close} busy={working}>
    {projectId !== null && !project ? <p role="alert">{t('projectMissing')}</p> : <div className="sd-stack">
      <p className="sd-small sd-muted">{t('projectOnly')}</p>
      {message && <p role="status" className="sd-draftbar">{message}</p>}
      {stale && <p role="alert">{pt('conflict')}</p>}
      {closing && <div className="sd-draftbar sd-stack" role="alert"><p>{t('unsavedHint')}</p><div className="sd-row"><button disabled={working} onClick={() => setClosing(false)}>{t('continueEditing')}</button><button className="sd-danger" disabled={working} onClick={onClose}>{t('discardClose')}</button></div></div>}
      <fieldset disabled={working} className="sd-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <form className="sd-stack" onSubmit={event => { event.preventDefault(); void saveProject() }}>
          <label className="sd-formfield"><span>{pt('projectName')}</span><input data-autofocus aria-label={pt('projectName')} maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          <ColorField label={pt('projectColor')} hint={t('optionalColor')} value={form.color} disabled={working} onChange={color => setForm({ ...form, color })}/>
          <fieldset className="sd-stack" style={{ minWidth: 0 }}><legend>{t('publicTags')}</legend><div className="sd-row">{board.tags.map(tag => <label key={tag.id} className="sd-row"><input type="checkbox" checked={form.tagIds.includes(tag.id)} onChange={event => setForm({ ...form, tagIds: event.target.checked ? [...form.tagIds, tag.id] : form.tagIds.filter(id => id !== tag.id) })}/><span>{tag.name}</span></label>)}</div>{!board.tags.length && <p className="sd-small sd-muted">{pt('noPublicTags')}</p>}</fieldset>
          <div className="sd-row"><button type="submit" className="sd-primary" disabled={!form.name.trim() || stale || tagName.trim().length > 0}>{pt(projectId === null ? 'createProject' : 'saveProject')}</button><button type="button" onClick={() => { setForm(projectFormOf(project)); setMessage(null); setClosing(false) }}>{pt('discardProject')}</button></div>
        </form>
        <div className="sd-row"><label className="sd-formfield"><span>{pt('tagName')}</span><input aria-label={pt('tagName')} maxLength={80} value={tagName} onChange={event => setTagName(event.target.value)}/></label><button disabled={!tagName.trim()} onClick={() => { void createTag() }}>{pt('createTag')}</button></div>
        {tagName.trim() && <p className="sd-small sd-muted">{pt('pendingTag')}</p>}
      </fieldset>
    </div>}
    <div className="sd-modal-foot"><button onClick={close} disabled={working}>{t('cancel')}</button></div>
  </Modal>
}
