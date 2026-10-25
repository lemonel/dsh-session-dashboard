import { z } from 'zod'
import { workflowBindingSchema } from '../shared/commands.js'

export const PROJECT_DRAG_TYPE = 'application/x-session-dashboard-project'
const id = z.string().min(1).max(240)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const projectDragSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sidebar'), sessionId: id, displayTitle: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('tracked'), sessionId: id, membershipId: id, metadataRevision: revision, binding: workflowBindingSchema, serviceId: z.string().uuid() }).strict(),
])
export type ProjectDrag = z.infer<typeof projectDragSchema>
export function parseProjectDrag(text: string): ProjectDrag | null {
  try { const value: unknown = JSON.parse(text); const result = projectDragSchema.safeParse(value); return result.success ? result.data : null } catch { return null }
}
