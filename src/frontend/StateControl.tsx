import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { Board, Card } from '../shared/model.js'
import { useDashboardLocale } from './i18n.js'
import { getPortalRenderer } from './portal.js'
import { attentionDetail, attentionKind, attentionLabel, attentionTone, canPickState, statusColorOf, statusFace, terminalDetail, UNSET_STATUS_COLOR } from './view-model.js'

/** One row of the picker. `value` is the command value, never a display string. */
interface StateOption { value: string; label: string; color: string; checked: boolean }
interface PanelRect { right: number; minWidth: number; top?: number; bottom?: number }

/** The plain, non-interactive face: the status name with its colour dot. Used by
 *  read-only cards and by the details drawer, so every surface paints one status
 *  the same way. */
export function StatusChip({ board, card, title }: { board: Board; card: Card; title?: string }) {
  const { t } = useDashboardLocale()
  const face = statusFace(board, card, t)
  return <span className="sd-status sd-state-static" data-status={card.placement.kind === 'builtin' ? card.placement.status : 'custom'} data-terminal={face.terminal ?? undefined} style={{ '--sd-chip-color': face.color } as CSSProperties} title={title ?? (face.terminal === null ? face.label : terminalDetail(card, t))}>
    <span className="sd-state-name">{face.label}</span>
  </span>
}

/** The one status control. It always shows the real placement with its colour — the
 *  derived attention layer is a separate danger-toned mark beside it, never a
 *  replacement for the status text. Clicking opens a listbox mounted on
 *  document.body through the host portal so clipped project rows cannot cut it; a
 *  pick turns into the matching command: choose_state while the round is settled,
 *  the acceptance path while it waits for review. A read-only card gets the same
 *  face without the menu. */
export function StateControl({ board, card, onChangeState, onReviewState, label, readOnly = false }: {
  board: Board
  card: Card
  onChangeState?: (card: Card, statusId: string | null) => void | Promise<void>
  onReviewState?: (card: Card, statusId: string | null) => void | Promise<void>
  label?: string
  readOnly?: boolean
}) {
  const { t } = useDashboardLocale()
  const attention = attentionKind(card)
  const mark = attentionLabel(card, t)
  const tone = attentionTone(card)
  const detail = attentionDetail(card, t)
  const status = statusFace(board, card, t)
  const outcome = status.terminal
  const running = card.runtime.phase === 'running' && attention === 'none'
  const statuses = board.statuses
  const currentStatus = card.placement.kind === 'custom' ? card.placement.statusId : null
  // A finished round can be placed directly: picking a status (or 已验收) from
  // 待确认 confirms the looked-at run first, then accepts into that destination.
  const awaitingDecision = card.status === 'pending_confirm' || card.status === 'pending_review'
  const reviewable = !readOnly && Boolean(onReviewState) && awaitingDecision && card.placement.kind === 'builtin' && card.placement.status === card.status
  const changeable = !readOnly && Boolean(onChangeState) && canPickState(card)
  const editable = changeable || reviewable
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [changing, setChanging] = useState(false)
  const [rect, setRect] = useState<PanelRect | null>(null)
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const name = label ?? t('changeStateFor', { title: card.titleOverride || card.hostTitle || card.sessionId })
  const statusText = status.label
  // A terminal system result takes over the chip text and its danger tone; the stored
  // status stays in_progress and the mark is suppressed so the two words never clash.
  const color = status.color
  const chipTitle = outcome === null ? undefined : terminalDetail(card, t)
  const dataStatus = card.placement.kind === 'builtin' ? card.placement.status : 'custom'
  const portal = getPortalRenderer()
  // Only board-wide custom statuses are pickable: built-in positions follow execution
  // facts, and acceptance has its own explicit option.
  const ordered = board.orders.status.ids.flatMap(row => { const status = statuses.find(item => item.id === row); return status ? [status] : [] })
  const options: StateOption[] = [
    ...ordered.map(status => ({ value: status.id, label: status.name, color: statusColorOf(board, status.id), checked: changeable && currentStatus === status.id })),
    ...(changeable ? [{ value: '__unset__', label: t('chooseUnset'), color: UNSET_STATUS_COLOR, checked: card.placement.kind === 'unset' }] : []),
    ...(reviewable ? [{ value: '__stay__', label: t('acceptAsAccepted'), color: statusColorOf(board, 'accepted'), checked: false }] : []),
  ]
  const selected = options.findIndex(option => option.checked)
  const close = (focus: boolean) => { setOpen(false); setRect(null); if (focus) trigger.current?.focus() }
  const measure = (): PanelRect | null => {
    const node = trigger.current
    if (!node) return null
    const box = node.getBoundingClientRect()
    const minWidth = Math.min(Math.max(box.width, 180), Math.max(120, window.innerWidth - 16))
    const right = Math.max(8, window.innerWidth - box.right)
    // Open upward when the viewport has more room above the trigger.
    return window.innerHeight - box.bottom >= 240 || window.innerHeight - box.bottom >= box.top
      ? { right, minWidth, top: box.bottom + 4 }
      : { right, minWidth, bottom: window.innerHeight - box.top + 4 }
  }
  const show = () => {
    if (!editable || changing) return
    const next = measure()
    if (!next) return
    setRect(next); setActive(selected >= 0 ? selected : 0); setOpen(true)
  }
  useEffect(() => { if (!editable) { setOpen(false); setRect(null) } }, [editable])
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const pointer = (event: Event) => { const target = event.target as Node | null; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false) }
    const dismiss = () => close(false)
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node | null)) close(false) }
    document.addEventListener('pointerdown', pointer, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])
  const focused = (self: HTMLElement): boolean => panel.current === self || Boolean(self.closest('.sd-statepanel'))
  const pick = (value: string) => {
    if (changing || !editable) return
    close(false)
    if (reviewable) {
      const statusId = value === '__stay__' || value === '__unset__' ? null : value
      setChanging(true)
      void Promise.resolve(onReviewState?.(card, statusId)).finally(() => { setChanging(false); trigger.current?.focus() })
      return
    }
    if (!onChangeState) return
    const statusId = value === '__unset__' ? null : value
    setChanging(true)
    void Promise.resolve(onChangeState(card, statusId)).finally(() => { setChanging(false); trigger.current?.focus() })
  }
  /** Keys are handled on both the trigger and the panel so the popup keeps its
   *  keyboard path whichever element currently holds focus. */
  const onKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (open) close(true); return }
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() }
      return
    }
    if (focused(event.currentTarget)) {
      if (event.key === 'Tab') { close(true); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        if (!options.length) return
        const last = options.length - 1
        setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? (index + 1 > last ? 0 : index + 1) : (index - 1 < 0 ? last : index - 1))
        return
      }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (options[active]) pick(options[active].value) }
    }
  }
  const panelNode = <div className="sd-statepanel" id={id} ref={panel} role="listbox" aria-label={name} tabIndex={-1} aria-activedescendant={options[active] ? `${id}-${active}` : undefined}
    style={{ position: 'fixed', zIndex: 60, top: rect?.top, bottom: rect?.bottom, right: rect?.right, minWidth: rect?.minWidth, maxWidth: 'min(260px, calc(100vw - 16px))', maxHeight: 240 }}
    onKeyDown={event => { event.stopPropagation(); onKey(event) }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.checked} tabIndex={-1}
      className="sd-stateoption" data-active={index === active ? 'true' : undefined} data-checked={option.checked ? 'true' : undefined}
      style={{ '--sd-chip-color': option.color } as CSSProperties}
      onPointerEnter={() => setActive(index)} onClick={event => { event.stopPropagation(); pick(option.value) }}>
      <span className="sd-stateoption-name">{option.label}</span><span className="sd-stateoption-check" aria-hidden="true">{option.checked ? '✓' : ''}</span>
    </div>)}</div>
  const markerText = mark === null ? null : t('attentionMarkTitle', { reason: detail ?? mark })
  const marker = mark === null || outcome !== null ? null : <span className="sd-attentionmark" role="img" aria-label={markerText ?? mark} title={markerText ?? mark} data-kind={attention} data-tone={tone ?? undefined}><span className="sd-attentionlabel">{mark}</span></span>
  const face = <>{running && <span className="sd-spinner" aria-hidden="true"/>}<span className="sd-state-name">{statusText}</span></>
  if (readOnly || !editable) return <span className="sd-status sd-state-static" data-status={dataStatus} data-terminal={outcome ?? undefined} style={{ '--sd-chip-color': color } as CSSProperties} title={chipTitle ?? t('stateUnavailableNow')}>{face}{marker}</span>
  return <span className="sd-statewrap" data-attention={attention === 'none' ? undefined : attention} data-busy={changing ? 'true' : undefined}>
    <button type="button" ref={trigger} className="sd-status sd-state-trigger" data-status={dataStatus} data-terminal={outcome ?? undefined} style={{ '--sd-chip-color': color } as CSSProperties}
      aria-label={chipTitle === undefined ? name : `${name}；${chipTitle}`} title={chipTitle} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={changing}
      onClick={() => open ? close(false) : show()} onKeyDown={onKey}>{face}<span className="sd-statecaret" aria-hidden="true">▾</span></button>
    {marker}
    {open && rect && (portal ? portal(panelNode, document.body) : panelNode)}
  </span>
}
