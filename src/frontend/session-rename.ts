import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Reference label for a row-initiated rename; kept apart from the native
 *  workspace operation so retention accounting stays readable. */
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sessionDashboardRow: unknown }
}

export type RenameOutcome = { ok: true; title: string } | { ok: false; error: string }

/** Rename the native Session title through the same Client Session Controller
 *  path the native conversation rename uses: retain the Session, rename it, and
 *  let the title projection follow. Nothing is retried and no history is opened. */
export async function renameNativeTitle(sessions: ISessions, sessionId: string, title: string): Promise<RenameOutcome> {
  try {
    const result = await sessions.using(sessionId as SessionId, { source: 'sessionDashboardRow' }, (reference: SessionReference) => reference.binding.session.rename(title))
    return result.ok ? { ok: true, title: result.value.title } : { ok: false, error: result.error.message }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
