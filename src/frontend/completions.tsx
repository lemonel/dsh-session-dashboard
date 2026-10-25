import { createElement, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { displayTitle } from '../shared/model.js'
import type { DashboardClient } from './client.js'
import { LocaleProvider } from './i18n.js'
import { acceptState, chooseState } from './state-actions.js'
import { reviewBinding } from './view-model.js'
import { TranscriptDialog, type PreviewRequest, type PreviewStateSource } from './TranscriptDialog.js'

type DashboardTranslate = TranslateNS<'sessionDashboard'>

export interface CompletionNotice { id: number; sessionId: string; title: string; nativeTitle: string; project: string | null; episodeId: string | null }

/** Newest first; older notices fall off so the stack never hides the page. */
export const MAX_COMPLETION_TOASTS = 4
type CompletionState = { unread: boolean; notices: CompletionNotice[]; notice: CompletionNotice | null }
class CompletionCenter {
  private state: CompletionState = { unread: false, notices: [], notice: null }
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = (): CompletionState => this.state
  private publish(next: CompletionState): void { this.state = next; for (const listener of this.listeners) listener() }
  notify(sessionId: string, title: string, nativeTitle: string, project: string | null, episodeId: string | null): void {
    this.sequence += 1
    // Newest first; the oldest falls out once the stack is full.
    const notices = [{ id: this.sequence, sessionId, title, nativeTitle, project, episodeId }, ...this.state.notices].slice(0, MAX_COMPLETION_TOASTS)
    this.publish({ unread: true, notices, notice: notices[0] })
  }
  dismiss(id: number): void {
    if (!this.state.notices.some(notice => notice.id === id)) return
    const notices = this.state.notices.filter(notice => notice.id !== id)
    this.publish({ ...this.state, notices, notice: notices[0] ?? null })
  }
  markRead(): void { if (this.state.unread) this.publish({ ...this.state, unread: false }) }
}
export const completionCenter = new CompletionCenter()

class PreviewCenter {
  private request: PreviewRequest | null = null
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = (): PreviewRequest | null => this.request
  open(request: PreviewRequest): void {
    const current = this.request
    // A pick is in flight: the chosen Session becomes the temporary second pane
    // and the hidden primary comes back unchanged. Pressing the primary again
    // would duplicate it, so that press only ends the pick.
    if (current?.picking === true) {
      if (current.sessionId === request.sessionId) { this.publish(this.unpick(current)); return }
      this.publish({ ...this.unpick(current), split: { sessionId: request.sessionId, title: request.title } })
      return
    }
    // "Side by side" only means something when another Session is already open:
    // keep the current primary and add the requested one as the second pane.
    this.publish(request.sideBySide && current !== null && current.sessionId !== request.sessionId
      ? { ...current, split: { sessionId: request.sessionId, title: request.title } }
      : request)
  }
  /** Hide the deck and wait for the user to pick the second Session. Only a
   *  primary without a second pane can start a pick. */
  beginSplit(): void {
    if (this.request === null || this.request.split != null || this.request.picking === true) return
    this.publish({ ...this.request, picking: true })
  }
  /** Cancel a pick without touching the original request. */
  cancelSplit(): void {
    if (this.request?.picking !== true) return
    this.publish(this.unpick(this.request))
  }
  closeSplit(): void {
    if (this.request?.split == null) return
    this.publish({ ...this.request, split: null })
  }
  close(): void { if (this.request === null) return; this.request = null; for (const listener of this.listeners) listener() }
  /** Leave picking by removing the marker, so the restored request is the exact
   *  object shape the preview had before the pick started. */
  private unpick(request: PreviewRequest): PreviewRequest {
    const next = { ...request }
    delete next.picking
    return next
  }
  private publish(request: PreviewRequest): void {
    this.request = request
    for (const listener of this.listeners) listener()
  }
}
export const previewCenter = new PreviewCenter()

/** Watch the already-running dashboard client, not a mounted panel, so a completed
 *  tracked Session still notifies while the user is elsewhere in DSH. */
export function watchCompletions(client: DashboardClient): () => void {
  const seen = new Map<string, string>()
  const known = new Set<string>()
  let primed = false
  return client.subscribe(() => {
    const snapshot = client.getSnapshot().snapshot
    if (!snapshot) return
    const board = snapshot.board
    const current = new Set(board.cards.map(card => card.sessionId))
    for (const id of seen.keys()) if (!current.has(id)) { seen.delete(id); known.delete(id) }
    if (!primed) {
      for (const card of board.cards) { known.add(card.sessionId); seen.set(card.sessionId, `${card.runtime.episodeId ?? ''}:${card.runtime.endedAt ?? ''}`) }
      primed = true
      return
    }
    for (const card of board.cards) {
      const key = `${card.runtime.episodeId ?? ''}:${card.runtime.endedAt ?? ''}`
      // A card that just entered the board (for example dragged into a project)
      // is a new membership, not a live completion event.
      if (!known.has(card.sessionId)) { known.add(card.sessionId); seen.set(card.sessionId, key); continue }
      if (seen.get(card.sessionId) === key) continue
      if (card.runtime.phase !== 'completed' || card.runtime.episodeId === null) { seen.set(card.sessionId, key); continue }
      // Only the main agent's settled result is worth a notification. A round whose
      // child agents still run is not settled yet, so keep the previous key and
      // re-check on later snapshots instead of notifying early.
      if ((card.runtime.activeAgents ?? 0) > 0) continue
      if (card.archivedAt !== null) { seen.set(card.sessionId, key); continue }
      // The dashboard's own settlement rule marks a round pending confirmation only
      // once no child agents are running; anything else is an intermediate cut.
      if (card.status !== 'pending_confirm' && card.status !== 'pending_review') { seen.set(card.sessionId, key); continue }
      if (card.decision?.episodeId === card.runtime.episodeId) { seen.set(card.sessionId, key); continue }
      seen.set(card.sessionId, key)
      const project = card.projectId ? board.projects.find(row => row.id === card.projectId)?.name ?? null : null
      completionCenter.notify(card.sessionId, displayTitle(card), card.hostTitle, project, card.runtime.episodeId)
    }
  })
}

function useCompletion(): CompletionState { return useSyncExternalStore(completionCenter.subscribe, completionCenter.getSnapshot, completionCenter.getSnapshot) }

/** Visible time of one completion toast. The countdown bar reads the same value. */
const TASK_COMPLETED_MS = 8000

/** One notice in the stack. Hovering (or focusing) it cancels the countdown for
 *  good: it becomes a manual todo the user closes when done. Untouched notices
 *  still disappear on their own after the configured delay. */
export function CompletionToastItem({ notice, t, canSplit, openPreview, dismissAfterMs = TASK_COMPLETED_MS }: {
  notice: CompletionNotice
  t: DashboardTranslate
  canSplit: boolean
  openPreview: (request: PreviewRequest) => void
  dismissAfterMs?: number
}) {
  const [cancelled, setCancelled] = useState(false)
  useEffect(() => {
    if (cancelled) return
    const timer = setTimeout(() => completionCenter.dismiss(notice.id), dismissAfterMs)
    return () => clearTimeout(timer)
  }, [notice.id, cancelled, dismissAfterMs])
  const cancel = () => setCancelled(true)
  // Acting on a notice consumes it: opening the preview (or the second pane)
  // removes just this toast instead of leaving it behind for a second click.
  const openFrom = (request: PreviewRequest) => {
    completionCenter.dismiss(notice.id)
    openPreview(request)
  }
  return <div className="sd-root sd-completion-toast" role="status" data-cancelled={cancelled ? 'true' : undefined}
    onMouseEnter={cancel} onFocus={cancel}>
    <div className="sd-completion-head"><span className="sd-completion-mark" aria-hidden="true">✓</span><strong>{t('taskCompleted')}</strong></div>
    <div className="sd-completion-body">
      <div className="sd-completion-copy"><p>{notice.project ? `${notice.project} - ` : ''}{notice.title}</p></div>
      <div className="sd-row"><button type="button" onClick={() => openFrom({ sessionId: notice.sessionId, title: notice.title, episodeId: notice.episodeId })}>{t('previewSession')}</button>{canSplit && <button type="button" onClick={() => openFrom({ sessionId: notice.sessionId, title: notice.title, episodeId: notice.episodeId, sideBySide: true })}>{t('openSideBySide')}</button>}<button type="button" className="sd-icon-btn" aria-label={t('close', { title: t('previewSession') })} onClick={() => completionCenter.dismiss(notice.id)}>×</button></div>
    </div>
    {!cancelled && <div className="sd-completion-track" aria-hidden="true"><span className="sd-completion-progress" style={{ animationDuration: `${dismissAfterMs}ms` }} /></div>}
  </div>
}

/** All pending notices, bottom-aligned and independently dismissible. */
export function CompletionToast({ t, openPreview, dismissAfterMs = TASK_COMPLETED_MS }: { t: DashboardTranslate; openPreview: (request: PreviewRequest) => void; dismissAfterMs?: number }) {
  const state = useCompletion()
  const preview = useSyncExternalStore(previewCenter.subscribe, previewCenter.getSnapshot, previewCenter.getSnapshot)
  if (state.notices.length === 0) return null
  return <div className="sd-completion-stack" role="region" aria-label={t('taskCompleted')}>
    {state.notices.map(notice => <CompletionToastItem key={notice.id} notice={notice} t={t} dismissAfterMs={dismissAfterMs} openPreview={openPreview} canSplit={preview !== null && preview.sessionId !== notice.sessionId} />)}
  </div>
}

function GlobalPreviewHost() {
  const request = useSyncExternalStore(previewCenter.subscribe, previewCenter.getSnapshot, previewCenter.getSnapshot)
  return <TranscriptDialog request={request}
    onClose={() => previewCenter.close()}
    onDetails={request?.onDetails}
    onCloseSplit={() => previewCenter.closeSplit()}
    onStartSplit={() => previewCenter.beginSplit()}
    onCancelSplit={() => previewCenter.cancelSplit()}/>
}

/** Register the completion dot's toast and one native-frame preview host at the
 *  frame level, so they keep working when the dashboard panel is not selected. */
export function registerCompletionOverlay(ctx: Pick<Context, 'slots' | 'locale'>, translate: DashboardTranslate, client: DashboardClient): void {
  // One live status source for every preview: a toast preview has no dashboard
  // context of its own, but the client can still read and change the tracked card.
  const state: PreviewStateSource = {
    subscribe: listener => client.subscribe(listener),
    read: sessionId => {
      const board = client.getSnapshot().snapshot?.board ?? null
      return { board, card: board?.cards.find(row => row.sessionId === sessionId && row.archivedAt === null) ?? null }
    },
    onChangeState: async (card, stateId) => { await chooseState(client, card, stateId) },
    onReviewState: async (card, stateId) => { await acceptState(client, card, stateId) },
  }
  const overlay = (id: string, order: number, children: () => ReactElement) => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id, order,
  }, () => createElement(LocaleProvider, { source: ctx.locale, t: translate, children: children() })))
  overlay('session-dashboard.completion', 460, () => createElement(CompletionToast, { t: translate, openPreview: request => {
    // Opening the content from the toast counts as looking at it.
    const board = client.getSnapshot().snapshot?.board
    const card = board?.cards.find(row => row.sessionId === request.sessionId && row.archivedAt === null)
    if (card && card.status === 'pending_confirm') void client.mutate({ type: 'confirm_review', ...reviewBinding(card) })
    previewCenter.open({ ...request, state: request.state ?? state })
  } }))
  overlay('session-dashboard.preview', 470, () => createElement(GlobalPreviewHost))
}
