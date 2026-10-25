import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { layoutController, sessionCatalogue, shownSession, type SessionCatalogue } from './host-services.js'

/** How long a link-opened tab waits for the native Session catalogue and then
 *  corrects a late boot restore. It is a normal page rather than a preview frame,
 *  so it keeps the more generous ten-second window. */
const SESSION_OPEN_RECONCILE_MS = 10_000

/** A new tab opened from a preview is a normal plugin page, but it must also reveal
 *  the Session the link named. Wait for the cold catalogue, then correct a late
 *  native boot restore through the same subscription the frame uses. */
export function revealLinkedSession(ctx: Context, target: string): void {
  ctx.inject(['uiWorkspace', 'layout'], child => {
    child.effect(() => {
      let finished = false
      let revealed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: (() => void) | undefined
      const deadline = Date.now() + SESSION_OPEN_RECONCILE_MS
      const catalogue = (): SessionCatalogue['list'] | undefined => sessionCatalogue(child)?.list
      // A late boot restore is observable through the catalogue subscription,
      // never a poll; `shownSession` is the same projection the preview uses.
      const shown = (list: SessionCatalogue['list']): string | null => shownSession(list)
      const finish = (): void => {
        if (finished) return
        finished = true
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        unsubscribe?.(); unsubscribe = undefined
        window.removeEventListener('pointerdown', finish, true)
        window.removeEventListener('keydown', finish, true)
      }
      const schedule = (delay: number) => {
        if (finished || timer !== undefined) return
        timer = setTimeout(() => { timer = undefined; attempt() }, delay)
      }
      const watch = (list: SessionCatalogue['list']): void => {
        if (unsubscribe !== undefined) return
        try {
          unsubscribe = list.subscribe(() => {
            // The catalogue arriving is the cold-start handshake; every later change
            // inside the window is a boot restore that must not steal the tab.
            if (finished || Date.now() > deadline) { finish(); return }
            let current: string | null = null
            try { current = shown(list) } catch { /* still booting */ }
            if (current === target) return
            attempt()
          })
        } catch { unsubscribe = undefined }
      }
      const attempt = (): void => {
        if (finished) return
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        const list = catalogue()
        if (!list) { if (Date.now() < deadline) schedule(150); return }
        watch(list)
        let catalogued = false
        let current: string | null = null
        try { catalogued = list.getSnapshot().ids.includes(target); current = shown(list) } catch { /* still booting */ }
        if (!catalogued) {
          // A cold native client may not have catalogued its Sessions when this
          // plugin applies. Calling openSession for an unknown id throws, so wait.
          if (Date.now() < deadline) schedule(150)
          return
        }
        // Do not re-open on every catalogue event once the requested Session is
        // already the one this tab renders; only a later boot restore is corrected.
        if (revealed) {
          // A real host can publish a catalogue event before its native retention
          // reports the reveal we just made, and a restore can briefly clear the
          // panel. A missing projection is not a competing choice: only a concrete
          // different Session is worth correcting, otherwise one link becomes two
          // opens (and visibly re-opens) on a slow start.
          if (current === target || current === null) return
        }
        try {
          // Claim the reveal before the call: the host republishes its catalogue from
          // inside openSession, and a synchronous subscription event would otherwise
          // re-enter this function while `revealed` is still false and open twice.
          revealed = true
          child.uiWorkspace.openSession(target as SessionId)
        } catch {
          revealed = false
          // The id can appear between the snapshot and the call; retry the wait
          // instead of spamming openSession.
          if (Date.now() < deadline) schedule(150)
          return
        }
        // openSession already reveals the Conversation; repeat it so a DSH panel
        // restored from persistence cannot hide the page.
        try { layoutController(child)?.selectPanel(null) } catch { /* the main key may not be registered yet */ }
      }
      // The user's next action always wins: clicking the dashboard entry must not
      // be pulled back to the Session by a boot restore after that press.
      window.addEventListener('pointerdown', finish, true)
      window.addEventListener('keydown', finish, true)
      attempt()
      return finish
    }, 'session-dashboard:open-session')
  })
}
