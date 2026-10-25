import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Reference label for a message sent by the dashboard's New session dialog;
 *  kept apart from the native workspace send path so retention stays readable. */
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sessionDashboardCreate: unknown }
}

export type PromptOutcome = { ok: true } | { ok: false; error: string }

/** Send the optional starting message through the same Client Session Controller
 *  path the native conversation uses: retain the Session, queue one text turn,
 *  and report the Host's reason instead of throwing. */
export async function promptNewSession(sessions: ISessions, sessionId: string, text: string): Promise<PromptOutcome> {
  try {
    const result = await sessions.using(sessionId as SessionId, { source: 'sessionDashboardCreate' }, (reference: SessionReference) => reference.binding.session.prompt([{ type: 'text', text }], 'queue'))
    return result.ok ? { ok: true } : { ok: false, error: result.error.message }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
