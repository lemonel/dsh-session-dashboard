import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createPreviewReconciler } from './preview-reconcile.js'
import { layoutController, sessionCatalogue, shownSession } from './host-services.js'

/** Split one `grid-template-columns` value into its top-level track tokens.
 *  Commas and spaces inside `minmax(…)` or `fit-content(…)` belong to a token. */
function gridTrackTokens(value: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/u.test(character)) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Zero the frame's leading navigation track inside the native inline template.
 *  Only that one token is rewritten, so every other track keeps the width the
 *  native layout gave it and the frame's own right-Sidebar toggle keeps working;
 *  a stylesheet `grid-template-columns` override would freeze all three and make
 *  that toggle look dead. */
function collapseLeadingTrack(frame: Element): void {
  const style = frame.getAttribute('style')
  if (style === null) return
  const declaration = /grid-template-columns\s*:\s*([^;]+)/iu.exec(style)
  if (declaration === null) return
  const tracks = gridTrackTokens(declaration[1])
  if (tracks.length === 0 || tracks[0] === '0px') return
  tracks[0] = '0px'
  frame.setAttribute('style', style.replace(declaration[0], `grid-template-columns: ${tracks.join(' ')}`))
}

/** The native preview frame is a second document. Run only the reveal/hide branch
 *  there: mounting the dashboard client again would start another poll loop,
 *  remote subscription and overlay set inside the frame for no benefit. */
export async function mountPreviewFrame(ctx: Context, previewSession: string): Promise<{ dispose(): Promise<void> }> {
  const preview = ctx.inject(['uiWorkspace', 'layout', 'sessions'], child => child.effect(() => {
    const sessions = sessionCatalogue(child)
    if (!sessions) return () => {}
    const style = document.createElement('style')
    style.dataset.sessionDashboardPreview = 'true'
    style.textContent = [
      // The frame is a full native client showing one Session. Drop only the
      // leading navigation column; the mark loop rewrites the native inline
      // grid template for that, so the trailing (right Sidebar) track keeps
      // the width the native layout gives it and its toggle still works.
      '[data-slot="sidebar"], [data-slot="shell.leading"] { display: none !important; }',
      '[data-session-dashboard-preview-frame] > [class*="sidebarCol"] { overflow: hidden !important; min-width: 0 !important; border: 0 !important; }',
      // Only the leading navigation handle goes: that column is forced to 0,
      // so its grabber would be a dead 8px strip on the left edge. The right
      // Sidebar keeps its own handle, so its width is adjustable in a preview
      // exactly as it is on the full page.
      '[data-session-dashboard-preview-frame] > [class*="handle"][data-side="sidebar"] { display: none !important; }',
    ].join('\n')
    document.head.append(style)
    // Mark the actual AppFrame, not a guessed wrapper: its overlay layer is a
    // stable direct child and its parent is the grid that owns both columns.
    let markedFrame: Element | null = null
    let frameObserver: MutationObserver | null = null
    const markFrame = () => {
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? document.querySelector('[data-rightbar-col]')?.parentElement ?? document.querySelector('[data-slot="root"] > div')
      if (!frame) return
      if (frame !== markedFrame) {
        // The native layout rewrites this attribute on every column change;
        // follow it instead of re-playing a frozen template of our own.
        frameObserver?.disconnect()
        markedFrame = frame
        frameObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => collapseLeadingTrack(frame)) : null
        frameObserver?.observe(frame, { attributes: true, attributeFilter: ['style'] })
      }
      frame.setAttribute('data-session-dashboard-preview-frame', '')
      collapseLeadingTrack(frame)
    }
    markFrame()
    const frameTimer = typeof window.setInterval === 'function' ? window.setInterval(markFrame, 250) : null
    let targetSession = previewSession
    let posted = 0
    // `sessions` republishes retention on every open, so this is also a change signal.
    const shown = (): string | null => shownSession(sessions.list)
    const notifyParent = () => {
      const now = Date.now()
      if (now - posted < 200) return
      posted = now
      // Report the Session that is live, not merely the one requested: the
      // parent may otherwise believe a failed switch succeeded.
      try { window.parent.postMessage({ type: 'session-dashboard-preview-change', sessionId: shown() ?? targetSession }, window.location.origin) } catch { /* cross-origin parent */ }
    }
    const openTarget = (id: string): boolean => {
      markFrame()
      if (!sessions.list.getSnapshot().ids.includes(id)) {
        // Calling openSession for an id this client has not catalogued throws,
        // and that throw skips selectPanel — the call aborting DSH's boot
        // restore navigation. The 1s/2s checks retry; after them the frame
        // stops correcting even if the catalogue arrived late.
        notifyParent()
        return false
      }
      try {
        child.uiWorkspace.openSession(id as SessionId)
        // openSession already reveals the Conversation; repeat it so a
        // DSH panel restored from persistence cannot hide the page.
        layoutController(child)?.selectPanel(null)
      } catch { notifyParent(); return false }
      notifyParent()
      return true
    }
    // Startup only: reveal now, verify at 1s and 2s, then stop. The window
    // covers a late native boot restore; afterwards the reader may open a
    // subagent link inside the frame without this guard pulling the target back.
    const reconcile = createPreviewReconciler({ open: openTarget, shown })
    const unsubscribe = sessions.list.subscribe(() => {
      notifyParent()
      // Catalogue arrival may finish an initial open that missed the ids. It
      // never re-pulls an already opened target when the reader navigates.
      reconcile.catalogueChanged()
    })
    const onOpen = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'session-dashboard-preview-open') return
      const next = (data as { sessionId?: unknown }).sessionId
      if (typeof next !== 'string' || next.length === 0) return
      // A handshake repeats the current target after a cold frame boot: honor
      // it as one navigation without restarting the startup checks. Only a
      // genuinely new target resets the 1s/2s schedule.
      const switched = next !== targetSession
      targetSession = next
      if (switched) reconcile.start(next)
      else reconcile.requestOpen()
    }
    window.addEventListener('message', onOpen)
    // The parent may have published a target before this listener existed.
    // Its listening handshake makes the parent resend the current target.
    try { window.parent.postMessage({ type: 'session-dashboard-preview-listening' }, window.location.origin) } catch { /* cross-origin parent */ }
    reconcile.start(targetSession)
    return () => {
      if (frameTimer !== null) window.clearInterval(frameTimer)
      frameObserver?.disconnect()
      reconcile.dispose()
      unsubscribe()
      window.removeEventListener('message', onOpen)
      style.remove()
      document.querySelector('[data-session-dashboard-preview-frame]')?.removeAttribute('data-session-dashboard-preview-frame')
    }
  }, 'session-dashboard:native-preview'))
  return { dispose: async () => { await preview.dispose() } }
}
