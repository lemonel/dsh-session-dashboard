import { z } from 'zod'
import type { Card } from '../shared/model.js'
import type { Command } from '../shared/commands.js'
import { reviewBinding } from './view-model.js'
import type { ReviewBinding } from './view-model.js'

export const draftSchema = z.object({
  sessionId: z.string().min(1), membershipId: z.string().uuid(), baseRevision: z.number().int().nonnegative(),
  titleOverride: z.string().max(160), progress: z.string().max(500),
  projectId: z.string().nullable(), tagIds: z.array(z.string()),
  tagName: z.string().max(80), original: z.string(),
}).strict()
export type CardDraft = z.infer<typeof draftSchema>
export interface EditorState { draft: CardDraft; binding: ReviewBinding; serviceId: string | null }
function metadata(value: Pick<CardDraft, 'titleOverride' | 'progress' | 'projectId' | 'tagIds'>): string {
  return JSON.stringify([value.titleOverride.trim() || null, value.progress, value.projectId, [...value.tagIds].sort()])
}
export function cardDraft(card: Card): CardDraft {
  const draft = { sessionId: card.sessionId, membershipId: card.membershipId, baseRevision: card.metadataRevision, titleOverride: card.titleOverride ?? '', progress: card.progress, projectId: card.projectId, tagIds: [...card.tagIds], tagName: '', original: '' }
  draft.original = metadata(draft)
  return draft
}
export function openEditor(card: Card): EditorState { return { draft: cardDraft(card), binding: reviewBinding(card), serviceId: null } }
/** Pending label creation is panel-local input, never an implicit create_label command. */
export function dirtyFields(draft: CardDraft): boolean { return metadata(draft) !== draft.original }
export function dirtyDraft(draft: CardDraft): boolean { return dirtyFields(draft) || draft.tagName.length > 0 }
export function editCommand(draft: CardDraft): Command {
  return { type: 'edit_card', sessionId: draft.sessionId, membershipId: draft.membershipId, expectedMetadataRevision: draft.baseRevision, titleOverride: draft.titleOverride.trim() || null, progress: draft.progress, tagIds: [...draft.tagIds] }
}
