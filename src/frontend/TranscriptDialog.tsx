import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Board, Card } from '../shared/model.js'
import { useTranslator } from './i18n.js'
import { NativePageFrame } from './NativePageFrame.js'
import { StateControl } from './StateControl.js'

/** Keep the native page alive for this long after the floating window closes.
 *  One frame is reused for every Session so previews never race each other. */
export const PREVIEW_CACHE_MS = 30 * 60 * 1000

/** How long a window keeps waiting for its frame to confirm the requested
 *  Session before it shows whatever is there. This matches the frame's own
 *  short startup window; after it, the reader owns the frame. */
export const PREVIEW_CONFIRM_MS = 2_000

export interface PreviewSplit { sessionId: string; title: string }
/** Live placement of a tracked Session, so the window's status control follows
 *  the board instead of the snapshot captured when the preview opened. */
export interface PreviewStateSource {
  subscribe: (listener: () => void) => () => void
  read: (sessionId: string) => { board: Board | null; card: Card | null }
  onChangeState: (card: Card, stateId: string | null) => void | Promise<void>
  onReviewState: (card: Card, stateId: string | null) => void | Promise<void>
}
export interface PreviewRequest { sessionId: string; title: string; nativeTitle?: string | null; episodeId?: string | null; split?: PreviewSplit | null; sideBySide?: boolean; /** The deck is hidden while the user picks the Session for the second pane. */ picking?: boolean; state?: PreviewStateSource; onDetails?: () => void }

/** The native Session page is a full client, not a component exported by a slot.
 *  The preview therefore hosts the real page in a same-origin frame and asks the
 *  plugin inside that frame to reveal the requested Session. One frame is kept
 *  alive and navigated; independent frames would share DSH's persistent current
 *  Session selection and race when the user switches conversations quickly. */
export function previewSource(sessionId: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('session-dashboard-preview', sessionId)
  return url.toString()
}

/** Open a real native DSH page in a new browser tab. The native client has no
 *  Session route, so the plugin inside that tab consumes this query parameter
 *  and switches its own main panel. Every other parameter (including a host
 *  token) is preserved, and the frame-only preview parameter is removed. */
export function sessionOpenSource(sessionId: string): string {
  const url = new URL(window.location.href)
  url.searchParams.delete('session-dashboard-preview')
  url.searchParams.set('session-dashboard-open', sessionId)
  return url.toString()
}

const NAVIGATE = 'session-dashboard-preview-open'
const LISTENING = 'session-dashboard-preview-listening'
/** The frame reports the Session it actually shows after each reveal. */
const CHANGE = 'session-dashboard-preview-change'

/* The native conversation body stamps the Session it renders. A title is not an
 * identity: the header renders the whole lineage, and a stale host title may
 * equal another Session's. This attribute is the frame's own answer. */
const SHOWN = '[data-conversation-session]'

function shownSession(frame: HTMLIFrameElement | null): string | null {
  try {
    return frame?.contentDocument?.querySelector(SHOWN)?.getAttribute('data-conversation-session') ?? null
  } catch {
    // A document mid-navigation has no readable DOM yet.
    return null
  }
}

function PreviewStatus({ source, sessionId }: { source: PreviewStateSource; sessionId: string }) {
  useSyncExternalStore(source.subscribe, () => {
    const { card } = source.read(sessionId)
    if (card === null) return 'none'
    const placement = card.placement.kind === 'custom' ? card.placement.statusId : card.placement.kind === 'builtin' ? card.placement.status : 'unset'
    return `${card.status}:${card.placement.kind}:${placement}:${card.workflowRevision}:${card.runtime.phase}`
  }, () => 'none')
  const { board, card } = source.read(sessionId)
  if (board === null || card === null) return null
  return <StateControl board={board} card={card} onChangeState={source.onChangeState} onReviewState={source.onReviewState} />
}

/** One whole floating window: its own head, actions and native client. Two
 *  windows are two clients, so neither can present the other's Session. */
function PreviewWindow({ sessionId, title, active, primary, canSplit, expanded = false, onToggleExpand, hint, state, onStartSplit, onClose, onDetails, onClosePane }: {
  sessionId: string
  title: string
  active: boolean
  primary: boolean
  /** Only the primary window without a second pane offers the pick entry. */
  canSplit?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  hint: string
  state?: PreviewStateSource
  onStartSplit?: () => void
  onClose: () => void
  onDetails?: () => void
  onClosePane: () => void
}) {
  const t = useTranslator()
  const [source, setSource] = useState(sessionId)
  const [reload, setReload] = useState(0)
  const [frameLoads, setFrameLoads] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [stalled, setStalled] = useState(false)
  const iframe = useRef<HTMLIFrameElement>(null)
  const target = sessionId

  const navigate = (id: string, delay = 0): ReturnType<typeof setTimeout> => setTimeout(() => {
    iframe.current?.contentWindow?.postMessage({ type: NAVIGATE, sessionId: id }, window.location.origin)
  }, delay)

  useEffect(() => {
    if (!active) return
    if (shownSession(iframe.current) === target) { setLoaded(true); setStalled(false); return }
    setLoaded(false); setStalled(false)
    // The frame itself opens this target immediately and rechecks it at 1s and
    // 2s. The parent only waits for that confirmation; it must not keep posting
    // navigation (or reload the frame), because after the window the reader may
    // deliberately follow a subagent inside the frame.
    const sent = [navigate(target, 0)]
    let stopped = false
    let poll: ReturnType<typeof setTimeout> | null = null
    const deadline = Date.now() + PREVIEW_CONFIRM_MS
    const tick = () => {
      poll = null
      if (stopped) return
      if (shownSession(iframe.current) === target) { setLoaded(true); setStalled(false); return }
      if (Date.now() >= deadline) {
        // Give the frame back even when confirmation never arrived. Keep it
        // visible and report the mismatch; only an explicit refresh reloads.
        setLoaded(true)
        setStalled(true)
        return
      }
      poll = setTimeout(tick, 150)
    }
    poll = setTimeout(tick, 150)
    return () => {
      stopped = true
      for (const item of sent) clearTimeout(item)
      if (poll !== null) clearTimeout(poll)
    }
  }, [active, target, reload, frameLoads])

  useEffect(() => {
    if (!active) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null) return
      const message = data as { type?: unknown; sessionId?: unknown }
      // The frame may confirm the target just after the parent stopped hiding
      // it. Reflect that confirmation without navigating: by now the reader owns
      // the frame, and a subagent report must never pull it back.
      if (message.type === CHANGE) {
        if (message.sessionId === target) { setLoaded(true); setStalled(false) }
        return
      }
      if (message.type !== LISTENING) return
      // The frame booted after the earlier attempt; repeat the current target
      // once. The frame's own 1s/2s checkpoints cover a late native restore.
      navigate(target)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [active, target])

  return <section className="sd-preview-pane sd-root" data-primary={primary ? 'true' : undefined} data-expanded={expanded ? 'true' : undefined}>
    <div className="sd-preview-pane-head">
      <h2 title={title}>{title}</h2>
      <div className="sd-row">
        {state && <PreviewStatus source={state} sessionId={sessionId} />}
        {primary && canSplit && onStartSplit && <button type="button" className="sd-small sd-preview-split" onClick={onStartSplit}>{t('openAnotherSideBySide')}</button>}
        <button type="button" className="sd-small" onClick={() => { setLoaded(false); setStalled(false); setSource(target); setReload(value => value + 1) }}>{t('refresh')}</button>
        <a className="sd-small sd-preview-enter" href={sessionOpenSource(sessionId)} target="_blank" rel="noopener noreferrer" aria-label={t('enterInspectNewTab')}>{t('enterInspectNewTab')}</a>
        {primary && onDetails && <button type="button" className="sd-small" onClick={onDetails}>{t('sessionDetails')}</button>}
        {onToggleExpand && <button type="button" className="sd-icon-btn sd-preview-expand" aria-label={expanded ? t('collapsePreview') : t('expandPreview')} title={expanded ? t('collapsePreview') : t('expandPreview')} onClick={onToggleExpand}>{expanded ? '⤡' : '⛶'}</button>}
        <button type="button" className="sd-icon-btn" aria-label={primary ? t('close', { title: t('previewSession') }) : t('closePane')} title={primary ? t('close', { title: t('previewSession') }) : t('closePane')} onClick={primary ? onClose : onClosePane}>×</button>
      </div>
    </div>
    <p className="sd-small sd-muted sd-preview-pane-hint">{hint}</p>
    <NativePageFrame key={`${source}:${reload}`} src={previewSource(source)} title={`${t('previewSession')}: ${title}`} pending={!loaded} frameRef={iframe} onLoad={() => setFrameLoads(value => value + 1)}>
      {!loaded && !stalled && <p className="sd-transcript-state" role="status">{t('previewSessionLoading')}</p>}
      {stalled && <p className="sd-transcript-state" role="status">{t('previewSessionStalled')}</p>}
    </NativePageFrame>
  </section>
}

/** Persistent floating native preview. Closing hides the frame and starts the
 *  cache timer; switching Sessions only navigates the already-booted client.
 *  A second window is another copy of the same window, booted on demand. */
export function TranscriptDialog({ request, onClose, onDetails, onCloseSplit, onStartSplit, onCancelSplit }: {
  request: PreviewRequest | null
  onClose: () => void
  onDetails?: () => void
  onCloseSplit: () => void
  /** Enter the explicit "pick another Session" mode; omitted when unavailable. */
  onStartSplit?: () => void
  onCancelSplit?: () => void
}) {
  const t = useTranslator()
  const [cached, setCached] = useState<PreviewRequest | null>(null)
  const [open, setOpen] = useState(false)
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRef = useRef(open); openRef.current = open
  const closeRef = useRef(onClose); closeRef.current = onClose
  // Picking hides the deck while keeping both frames mounted, and Escape cancels
  // the pick instead of closing the whole preview during that mode.
  const picking = open && cached?.picking === true
  const pickingRef = useRef(picking); pickingRef.current = picking
  const cancelSplitRef = useRef(onCancelSplit); cancelSplitRef.current = onCancelSplit

  useEffect(() => {
    if (request !== null) {
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
      setCached(request)
      setOpen(true)
      return
    }
    if (!openRef.current) return
    setOpen(false)
    // The second window exists only while the deck is open: closing keeps the
    // primary client cached for 30 minutes but never keeps a second one alive.
    setCached(current => current === null || current.split == null ? current : { ...current, split: null })
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setCached(null)
    }, PREVIEW_CACHE_MS)
  }, [request?.sessionId, request?.title, request?.split?.sessionId, request?.picking])

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  useEffect(() => {
    if (!open) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Cancelling a pick only restores the original preview: the request itself
      // (its Session, split and handlers) is left exactly as it was.
      if (pickingRef.current) { event.preventDefault(); event.stopPropagation(); cancelSplitRef.current?.(); return }
      const dialogs = [...document.querySelectorAll('[data-sd-dialog]')]
      const deck = document.querySelector('[data-sd-dialog="true"].sd-preview-deck')
      if (dialogs[dialogs.length - 1] !== deck) return
      event.preventDefault(); event.stopPropagation(); closeRef.current()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [open])

  if (cached === null) return null
  const split = cached.split ?? null
  const expanded = expandedFor === cached.sessionId && split === null
  const hint = split ? t('previewSideBySideHint') : t('previewSessionHint')
  // The hidden deck stays mounted, so both native clients are only hidden from
  // the dashboard while the user picks the second Session; it never intercepts
  // a press and is not the topmost dialog in that mode.
  const hidden = !open || picking
  return <>
  <div className="sd-overlay" data-preview-cache="true" hidden={hidden} aria-hidden={hidden} onMouseDown={event => {
    // Only the mask closes. A press anywhere inside the deck (windows, the gap
    // between two of them, a button, a scrollbar or a text selection) must not.
    // Clicks inside the native iframe never reach this document at all.
    const target = event.target as HTMLElement | null
    if (target?.closest('.sd-preview-deck')) return
    onClose()
  }}>
    <div className="sd-preview-deck sd-preview-panes" data-sd-dialog={open && !picking ? 'true' : undefined} data-panes={split ? '2' : '1'} data-expanded={expanded ? 'true' : undefined} role="dialog" aria-modal={open && !picking ? 'true' : undefined} aria-label={t('previewSession')}>
      <PreviewWindow key="primary" sessionId={cached.sessionId} title={cached.title} active={open} primary canSplit={split === null} expanded={expanded} onToggleExpand={split === null ? () => setExpandedFor(expanded ? null : cached.sessionId) : undefined} hint={hint} state={cached.state} onStartSplit={onStartSplit} onClose={onClose} onDetails={onDetails} onClosePane={onCloseSplit} />
      {split && <PreviewWindow key={`split:${split.sessionId}`} sessionId={split.sessionId} title={split.title} active={open} primary={false} hint={hint} state={cached.state} onClose={onClose} onClosePane={onCloseSplit} />}
    </div>
  </div>
  {picking && <div className="sd-root sd-split-pickbar" role="region" aria-label={t('pickSideBySideHint')}>
    <p role="status">{t('pickSideBySideHint')}</p>
    <button type="button" className="sd-small" onClick={onCancelSplit}>{t('cancelSideBySidePick')}</button>
  </div>}
  </>
}
