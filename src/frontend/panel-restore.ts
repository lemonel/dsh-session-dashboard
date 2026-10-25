import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** The one localStorage slot that remembers which central panel the user chose.
 *  A plugin panel id is the only value ever stored; a native conversation is the
 *  absence of the key, so a user who left the native view is not pulled back. */
export const PANEL_PREFERENCE_KEY = 'session-dashboard:last-panel'

/** The layout face these watchers need. A host fixture without `layout` never
 *  installs them, so the dashboard still mounts in isolation. */
export interface PanelSelection {
  readonly panelInfo: { getSnapshot(): { readonly activePanelId: MainPanelId | null }; subscribe(listener: () => void): () => void }
  selectPanel(panelId: MainPanelId | null): void
}
export interface PanelWindowOptions {
  /** Window that owns storage and the top-level check; window by default. */
  window?: Window | null
}
export interface PanelRestoreOptions extends PanelWindowOptions {
  /** How long after boot a late native session restore may be corrected. */
  windowMs?: number
  /** Poll interval for a panel that is not registered yet. */
  intervalMs?: number
  /** Object that owns the interaction listeners; window by default. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
}

const currentWindow = (options?: PanelWindowOptions): Window | null => options?.window === undefined ? (typeof window === 'undefined' ? null : window) : options.window
/** A frame (preview, official new-session, …) loads the same DSH page. Panel
 *  restoration must never run there: it would switch the frame to the dashboard and
 *  destroy whatever the host is showing. A cross-origin `top` access throws, so it
 *  counts as non-top-level too. */
export function isTopLevelWindow(win: Window | null = currentWindow()): boolean {
  if (!win) return false
  try { return win.top === win.self } catch { return false }
}
const storage = (win: Window | null): Storage | null => {
  try { return win === null ? null : win.localStorage } catch { return null }
}
const readPreference = (panelId: MainPanelId, win: Window | null): boolean => {
  try { return storage(win)?.getItem(PANEL_PREFERENCE_KEY) === panelId } catch { return false }
}
const writePreference = (panelId: MainPanelId | null, win: Window | null): void => {
  try { const store = storage(win); if (!store) return; if (panelId === null) store.removeItem(PANEL_PREFERENCE_KEY); else store.setItem(PANEL_PREFERENCE_KEY, panelId) } catch { /* private mode or a blocked storage partition */ }
}

/** Remember the user's real choice: the dashboard panel stores itself, every other
 *  selection (a native session or another panel) clears the preference. Only an
 *  actual panelInfo change is recorded, never the boot-time initial value. */
export function watchPanelPreference(layout: PanelSelection, panelId: MainPanelId, options: PanelWindowOptions = {}): () => void {
  const win = currentWindow(options)
  // A frame neither reads nor writes the preference and never claims the panel.
  if (!isTopLevelWindow(win)) return () => {}
  const record = (): void => {
    let active: MainPanelId | null
    try { active = layout.panelInfo.getSnapshot().activePanelId } catch { return }
    writePreference(active === panelId ? panelId : null, win)
  }
  return layout.panelInfo.subscribe(record)
}

/** Re-apply the remembered dashboard panel during the boot window. The host restores
 *  the last conversation on boot and may do it after this plugin's apply ran, so a
 *  successful first attempt is not enough: a later panel change inside the window is
 *  corrected too. Polling stops once the panel sticks; the listener, the deadline and
 *  the user's first interaction always end the whole restore. */
export function restorePanelOnBoot(layout: PanelSelection, panelId: MainPanelId, options: PanelRestoreOptions = {}): () => void {
  const win = currentWindow(options)
  if (!isTopLevelWindow(win)) return () => {}
  if (!readPreference(panelId, win)) return () => {}
  const windowMs = options.windowMs ?? 5000, intervalMs = options.intervalMs ?? 100
  const target = options.target === undefined ? win : options.target
  const startedAt = Date.now(), deadlineAt = startedAt + windowMs
  let done = false, settled = false
  let poll: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const active = (): MainPanelId | null => { try { return layout.panelInfo.getSnapshot().activePanelId } catch { return null } }
  const stopPolling = (): void => { if (poll !== undefined) { clearTimeout(poll); poll = undefined } }
  const cleanup = (): void => {
    stopPolling()
    if (deadline !== undefined) { clearTimeout(deadline); deadline = undefined }
    unsubscribe?.(); unsubscribe = undefined
    target?.removeEventListener('pointerdown', finish, true)
    target?.removeEventListener('keydown', finish, true)
  }
  const finish = (): void => { if (done) return; done = true; cleanup() }
  const attempt = (): void => {
    if (done) return
    if (active() === panelId) { settled = true; stopPolling(); return }
    try { layout.selectPanel(panelId) } catch { /* the main key is not registered yet */ }
    if (active() === panelId) { settled = true; stopPolling(); return }
    if (settled || poll !== undefined) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return
    poll = setTimeout(() => { poll = undefined; if (!settled) attempt() }, Math.min(intervalMs, remaining))
  }
  // A user action always wins: stop correcting immediately, even inside the window.
  target?.addEventListener('pointerdown', finish, true)
  target?.addEventListener('keydown', finish, true)
  unsubscribe = layout.panelInfo.subscribe(attempt)
  deadline = setTimeout(finish, windowMs)
  attempt()
  return finish
}
