import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Create a blank Host Session in an explicitly chosen Workspace.
 *
 *  The Host's session controller attaches the new Session like the native New
 *  session flow does; the dashboard never opens or navigates to it. Failures
 *  propagate so the caller can report the Host's reason. */
export async function createSessionInWorkspace(sessions: ISessions, workspaceId: string): Promise<string> {
  return String(await sessions.create({ workspaceId: workspaceId as WorkspaceId }))
}

/** A bounded, visible reason for a refused creation. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const trimmed = message.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed || 'unknown'
}
