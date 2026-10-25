import { EMPTY, statusSchema, type Status } from '../shared/model.js'
import type { Board, Card, Dimension, Label, Preferences } from '../shared/model.js'
import type { StateTarget, WorkflowBinding } from '../shared/commands.js'
import { defaultTranslator, type TranslationKey } from './i18n.js'

export type Entry = Preferences['entry']
export type ReviewAction = 'accept' | 'return' | 'reopen'
export type ReviewBinding = WorkflowBinding
export const NATIVE_STATUSES: readonly string[] = statusSchema.options
export function labels(board: Board, dimension: Exclude<Dimension, 'status'>): Label[] {
  const values = dimension === 'project' ? board.projects : board.tags
  return board.orders[dimension].ids.flatMap(id => { const value = values.find(row => row.id === id); return value ? [value] : [] })
}
export function valueText(board: Board, dimension: Dimension, id: string | null, t = defaultTranslator): string {
  if (dimension === 'status') {
    if (id === 'in_progress' || id === 'pending_confirm' || id === 'pending_review' || id === 'accepted') return t(id)
    return board.statuses.find(row => row.id === id)?.name ?? t('deletedOption')
  }
  if (id === null || id === EMPTY) return t(dimension === 'project' ? 'unassigned' : 'unsetTag')
  return labels(board, dimension).find(row => row.id === id)?.name ?? t('deletedOption')
}
export function projectTags(board: Board, card: Card): string[] { return board.projects.find(project => project.id === card.projectId)?.tagIds ?? [] }
export function effectiveTags(board: Board, card: Card): string[] { return [...new Set([...card.tagIds, ...projectTags(board, card)])] }
/** One colour per status, shared by the chip, the dropdown and the board column.
 *  Built-ins keep fixed semantic tones; a custom status uses its own colour and a
 *  status without one falls back to the neutral faint tone. */
export const NATIVE_STATUS_COLOR: Readonly<Record<Status, string>> = { in_progress: 'var(--sd-info)', pending_confirm: 'var(--sd-info)', pending_review: 'var(--sd-warn)', accepted: 'var(--sd-ok)' }
export const UNSET_STATUS_COLOR = 'var(--sd-faint)'
export function statusColorOf(board: Board, id: string | null | undefined): string {
  if (id === null || id === undefined || id === 'unset') return UNSET_STATUS_COLOR
  const native = (NATIVE_STATUS_COLOR as Readonly<Record<string, string>>)[id]
  if (native !== undefined) return native
  const status = board.statuses.find(row => row.id === id)
  return status?.color ?? UNSET_STATUS_COLOR
}
/** Non-archived sessions that belong to a project, counted by the same derived
 *  status the card shows and returned in status order (terminal faces before
 *  unset, empty groups omitted). The cards, their chips and the status filter
 *  all share statusBucket, so they cannot disagree. */
/** The board-wide status order: configured statuses, derived terminal faces next
 *  to In progress (the bucket they override), and unset last. */
export function statusRowIds(board: Board): string[] {
  const order = [...board.orders.status.ids, 'unset']
  order.splice(Math.max(0, order.indexOf('in_progress') + 1), 0, ...TERMINAL_OUTCOMES.map(terminalBucketId))
  return order
}
/** Count any card list by the same derived status the rows display. */
export function statusSummary(board: Board, cards: readonly Card[]): { id: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const card of cards) {
    const id = statusBucket(card)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return statusRowIds(board).flatMap(id => { const count = counts.get(id); return count === undefined ? [] : [{ id, count }] })
}
export function projectStatusSummary(board: Board): { id: string; count: number }[] {
  return statusSummary(board, board.cards.filter(card => card.archivedAt === null && card.projectId !== null))
}
export function projectStatusCounts(board: Board): { id: string; count: number }[] {
  return projectStatusSummary(board)
}
/** The derived attention layer is orthogonal to the stored status: it never
 *  replaces the status text, it only explains why the session needs a human.
 *  One table carries both the reason and the short mark label for each value. */
const ATTENTION_FACES: Record<Exclude<Card['runtime']['attention'], 'none'>, { reason: TranslationKey; label: TranslationKey }> = {
  answer: { reason: 'waiting_input', label: 'attentionInput' },
  approve: { reason: 'waiting_approval', label: 'attentionApproval' },
  sync: { reason: 'awaitingSync', label: 'attentionSync' },
  failure: { reason: 'failed', label: 'needsActionBadge' },
  interrupted: { reason: 'interrupted', label: 'needsActionBadge' },
  blocked: { reason: 'blocked', label: 'attentionBlocked' },
  paused: { reason: 'paused', label: 'attentionResume' },
  resume: { reason: 'needsResume', label: 'attentionResume' },
}
export function attentionReasonKey(attention: Card['runtime']['attention']): TranslationKey | null {
  return attention === 'none' ? null : ATTENTION_FACES[attention].reason
}
export function attentionReason(card: Card, t = defaultTranslator): string | null {
  const key = attentionReasonKey(attentionKind(card))
  return key === null ? null : t(key)
}
/** A short, human label for the attention mark. The system's own turn-end reason
 *  wins because it names what actually happened (failed / interrupted / stopped);
 *  only a healthy end falls back to what the human still has to do. */
export function attentionLabel(card: Card, t = defaultTranslator): string | null {
  const end = card.runtime.turnEnd
  if (end) {
    if (end.kind === 'error') return t('attentionFailed')
    if (end.kind === 'interrupted' || end.kind === 'max-tokens') return t('attentionInterrupted')
    if (end.kind === 'aborted') return end.cause === 'user' ? t('attentionStopped') : t('attentionInterrupted')
    if (end.kind === 'blocked') return t('attentionBlocked')
  }
  const attention = attentionKind(card)
  return attention === 'none' ? null : t(ATTENTION_FACES[attention].label)
}
/** Tone for the mark: a system failure or interruption is danger, a human wait is
 *  a warning. The colour never implies a dashboard status. */
export function attentionTone(card: Card): 'danger' | 'warn' | null {
  const end = card.runtime.turnEnd
  if (end) {
    if (end.kind === 'error' || end.kind === 'interrupted' || end.kind === 'max-tokens' || end.kind === 'aborted') return 'danger'
    if (end.kind === 'blocked') return 'warn'
  }
  const attention = attentionKind(card)
  if (attention === 'none') return null
  return attention === 'failure' || attention === 'interrupted' ? 'danger' : 'warn'
}
/** Title/reading text for the mark: the host's explanation is the concrete reason;
 *  without one the derived attention kind still names a cause. */
export function attentionDetail(card: Card, t = defaultTranslator): string | null {
  const explanation = card.runtime.explanation?.trim()
  if (explanation) return explanation
  return attentionReason(card, t)
}
/** A terminal system result is a different kind of fact from an in-progress
 *  disposition: a crashed, failed or stopped run is still stored as in_progress until
 *  a human moves it, but showing both words at once is self-contradictory. Only the
 *  built-in in-progress placement can be overridden this way; the stored status and
 *  placement never change. */
export type TerminalOutcome = 'interrupted' | 'failed' | 'stopped'
/** Summary-only bucket ids for the card's terminal face. They never replace the
 *  stored status or placement, and they cannot collide with a status UUID. */
export const TERMINAL_BUCKET_PREFIX = 'terminal:'
export const TERMINAL_OUTCOMES: readonly TerminalOutcome[] = ['stopped', 'interrupted', 'failed']
export function terminalBucketId(outcome: TerminalOutcome): string { return `${TERMINAL_BUCKET_PREFIX}${outcome}` }
export function terminalBucketOutcome(id: string): TerminalOutcome | null {
  if (!id.startsWith(TERMINAL_BUCKET_PREFIX)) return null
  const value = id.slice(TERMINAL_BUCKET_PREFIX.length)
  return value === 'stopped' || value === 'interrupted' || value === 'failed' ? value : null
}
export function terminalStatusLabel(outcome: TerminalOutcome, t = defaultTranslator): string {
  return outcome === 'failed' ? t('attentionFailed') : outcome === 'stopped' ? t('attentionStopped') : t('attentionInterrupted')
}
export type StatusKind = 'workflow' | 'custom' | 'unset' | 'terminal'
/** Which kind of label a bucket is. Only workflow labels are stored card states
 *  the backend gates on; custom/unset are user placement, terminal is a derived
 *  display face of the runtime turn end. */
export function statusBucketKind(id: string): StatusKind {
  if (terminalBucketOutcome(id) !== null) return 'terminal'
  if (id === 'unset') return 'unset'
  return (NATIVE_STATUSES as readonly string[]).includes(id) ? 'workflow' : 'custom'
}
export function terminalOutcome(card: Card): TerminalOutcome | null {
  const end = card.runtime.turnEnd
  if (!end || card.status !== 'in_progress' || card.placement.kind !== 'builtin' || card.placement.status !== 'in_progress') return null
  if (end.kind === 'interrupted' || end.kind === 'max-tokens') return 'interrupted'
  if (end.kind === 'error') return 'failed'
  if (end.kind === 'aborted') return end.cause === 'user' ? 'stopped' : 'interrupted'
  return null
}
/** The display/filter identity: the card's visible terminal face when it has
 *  one, otherwise its stored status bucket. Card chips, the project summary and
 *  the summary filter share this; board columns keep the workflow bucket below. */
export function statusBucket(card: Card): string {
  const outcome = terminalOutcome(card)
  return outcome === null ? bucketId(card, 'status') : terminalBucketId(outcome)
}
export function statusBucketLabel(board: Board, id: string, t = defaultTranslator): string {
  const outcome = terminalBucketOutcome(id)
  if (outcome !== null) return terminalStatusLabel(outcome, t)
  return id === 'unset' ? t('unsetState') : valueText(board, 'status', id, t)
}
export function statusBucketColor(board: Board, id: string): string {
  return terminalBucketOutcome(id) !== null ? 'var(--sd-danger)' : id === 'unset' ? UNSET_STATUS_COLOR : statusColorOf(board, id)
}
/** One face for every status surface: the bucket identity used for grouping and
 *  filtering, plus the exact label and colour the reader sees. */
export interface StatusFace { bucket: string; kind: StatusKind; label: string; color: string; terminal: TerminalOutcome | null }
export function statusFace(board: Board, card: Card, t = defaultTranslator): StatusFace {
  const bucket = statusBucket(card)
  return { bucket, kind: statusBucketKind(bucket), label: statusBucketLabel(board, bucket, t), color: statusBucketColor(board, bucket), terminal: terminalBucketOutcome(bucket) }
}
export function terminalLabel(card: Card, t = defaultTranslator): string | null {
  const outcome = terminalOutcome(card)
  return outcome === null ? null : terminalStatusLabel(outcome, t)
}
/** The chip keeps the host explanation and says plainly that only the label changed. */
export function terminalDetail(card: Card, t = defaultTranslator): string {
  const detail = attentionDetail(card, t) ?? terminalLabel(card, t) ?? ''
  return `${detail} · ${t('stateStillInProgress')}`.trim()
}
export function originText(card: Card, t = defaultTranslator): string {
  return card.origin?.kind === 'state' ? card.origin.state.statusName : t('unspecifiedOrigin')
}
export function runtimeText(card: Card, t = defaultTranslator): string {
  if (card.runtime.sync === 'missing') return t('unavailableSession')
  if (card.runtime.sync !== 'synced') return t('awaitingSync')
  if (!card.runtime.sourceLive && awaitingReview(card)) return t('completedCold')
  // A session whose own driver is parked while child agents still run is working.
  if (childAgentsRunning(card)) return t('running')
  if (card.placement.kind === 'builtin' && card.placement.status === 'in_progress' && (card.decision?.kind === 'returned' || card.decision?.kind === 'reopened') && card.decision.episodeId === card.runtime.episodeId) return t('resumePending')
  if (card.runtime.attention === 'blocked') return t('blocked')
  if (card.runtime.attention === 'paused') return t('paused')
  if (card.runtime.attention === 'resume') return t('needsResume')
  return card.runtime.phase === 'unknown' ? t('awaitingSync') : t(card.runtime.phase)
}
/** True while child agents still run under this session: either the main driver
 *  is parked waiting for them, or its turn ended but their work has not. */
export function childAgentsRunning(card: Card): boolean {
  if ((card.runtime.activeAgents ?? 0) <= 0) return false
  if (card.runtime.phase === 'completed') return true
  return card.runtime.attention === 'resume'
    && (card.runtime.phase === 'suspended' || card.runtime.phase === 'continuation_pending')
}
/** Absolute start of the round a row paints as running (main turn, children after
 *  the main turn, or a parked main waiting on children). Waiting-for-human and
 *  goal gaps intentionally have no running clock. */
export function runningElapsedStart(card: Card): number | null {
  if (card.runtime.sync !== 'synced' || !card.runtime.sourceLive) return null
  const startedAt = card.runtime.startedAt
  if (startedAt === null) return null
  const active = card.runtime.phase === 'running' && card.runtime.attention === 'none' || childAgentsRunning(card)
  return active ? startedAt : null
}
export function runtimeGuidance(card: Card, t = defaultTranslator): { explanation: string | null; nextStep: string } | null {
  if (card.runtime.sync !== 'synced') return null
  if (!card.runtime.sourceLive) return awaitingReview(card) ? { explanation: card.runtime.explanation?.trim() || null, nextStep: t('guideColdReview') } : null
  const phase = card.runtime.phase
  const nextStep = phase === 'waiting_input' ? t('guideInput') : phase === 'waiting_approval' ? t('guideApproval') : phase === 'suspended' ? t('guideSuspended') : phase === 'failed' ? t('guideFailed') : phase === 'interrupted' ? t('guideInterrupted') : phase === 'continuation_pending' ? t('guideContinuation') : null
  const explanation = card.runtime.explanation?.trim() || null
  return explanation || nextStep ? { explanation, nextStep: nextStep ?? t('guideRuntime') } : null
}
export function needsAction(card: Card): boolean { return attentionKind(card) !== 'none' }
/** A completed round waiting for review is a review item even when the observation
 *  is cold: nothing is waiting on the user, and acceptance — which does need a
 *  live check — reports its own reason instead of hiding the card. */
function awaitingReview(card: Card): boolean {
  return card.placement.kind === 'builtin' && (card.placement.status === 'pending_confirm' || card.placement.status === 'pending_review') && card.runtime.phase === 'completed' && card.runtime.episodeId !== null
}
export function attentionKind(card: Card): Card['runtime']['attention'] {
  if (card.runtime.sync !== 'synced') return 'sync'
  if (!card.runtime.sourceLive && !awaitingReview(card)) return 'sync'
  if (childAgentsRunning(card)) return 'none'
  return card.runtime.attention
}
export function hostArchiveText(value: Card['hostArchive'], t = defaultTranslator): string { return t(value.state === 'active' ? 'hostActive' : value.state === 'archived' ? 'hostArchived' : value.state === 'unsupported' ? 'hostUnsupported' : 'hostUnknown') }
export function running(card: Card): boolean { return ['running', 'waiting_input', 'waiting_approval', 'continuation_pending', 'suspended'].includes(card.runtime.phase) }
export function reviewBucket(card: Card): 0 | 1 | 2 | 3 {
  if (needsAction(card)) return 0
  if (card.placement.kind === 'builtin' && card.placement.status === 'pending_confirm') return 1
  if (card.placement.kind === 'builtin' && card.placement.status === 'pending_review') return 2
  return 3
}
export function entryCards(board: Board, entry: Entry): Card[] {
  return board.cards.filter(card => entry === 'archive' ? card.archivedAt !== null : card.archivedAt === null && (entry !== 'review' || card.placement.kind === 'builtin' && (card.placement.status === 'pending_confirm' || card.placement.status === 'pending_review') || entry === 'review' && needsAction(card)) && (entry !== 'attention' || needsAction(card)) && (entry !== 'unassigned' || card.projectId === null))
}

/** Persisted workflow bucket: the placement state the backend gates on. Board
 *  columns and the FilterBar group by this; display faces use statusBucket. */
export function bucketId(card: Card, groupBy: 'status' | 'project'): string {
  return groupBy === 'status' ? card.placement.kind === 'builtin' ? card.placement.status : card.placement.kind === 'unset' ? 'unset' : card.placement.statusId : card.projectId ?? EMPTY
}
export function reviewBinding(card: Card): WorkflowBinding {
  return { sessionId: card.sessionId, membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision, expectedLifecycleRevision: card.lifecycleRevision, expectedWorkflowRevision: card.workflowRevision, episodeId: card.runtime.episodeId }
}
export function bindingMatches(card: Card, binding: WorkflowBinding): boolean {
  return card.sessionId === binding.sessionId && card.membershipId === binding.membershipId && card.lifecycleRevision === binding.expectedLifecycleRevision && card.metadataRevision === binding.expectedMetadataRevision && card.workflowRevision === binding.expectedWorkflowRevision && card.runtime.episodeId === binding.episodeId
}
export function reviewProblemKey(card: Card, action: ReviewAction, binding: ReviewBinding, ready: boolean): TranslationKey | null {
  if (card.archivedAt !== null) return 'reviewArchived'
  if (!bindingMatches(card, binding)) return 'reviewStale'
  if (action === 'accept') {
    if (!ready || card.runtime.sync !== 'synced') return 'reviewUnsynced'
    if (!card.runtime.sourceLive) return 'reviewCold'
    if (card.placement.kind !== 'builtin' || (card.placement.status !== 'pending_review' && card.placement.status !== 'pending_confirm') || card.runtime.phase !== 'completed' || card.runtime.episodeId === null) return 'reviewIncomplete'
  } else if (card.placement.kind !== 'builtin' || (action === 'return' ? card.placement.status !== 'pending_review' : card.placement.status !== 'accepted')) return 'reviewChanged'
  return null
}
export function reviewProblem(card: Card, action: ReviewAction, binding: ReviewBinding, ready: boolean, t = defaultTranslator): string | null {
  const key = reviewProblemKey(card, action, binding, ready)
  return key === null ? null : t(key)
}
export function canPickState(card: Card): boolean {
  if (!canChooseState(card) || running(card)) return false
  if (card.status === 'accepted') return card.decision?.kind === 'accepted' && card.runtime.phase === 'completed' || card.decision?.kind === 'historical' && card.runtime.phase === 'not_started' && card.runtime.episodeId === null
  return card.runtime.phase === 'not_started' && card.runtime.episodeId === null && card.runtime.episodeOrder === 0 && card.runtime.attention === 'none'
}
export function canChooseState(card: Card): boolean {
  if (card.archivedAt !== null || card.runtime.sync !== 'synced' || !card.runtime.sourceLive) return false
  if (card.placement.kind !== 'builtin') return true
  if (card.placement.status === 'accepted') return true
  return card.runtime.phase === 'not_started' && card.runtime.episodeId === null && card.runtime.episodeOrder === 0 && card.runtime.attention === 'none'
}
export function targetFor(board: Board, statusId: string): StateTarget | null {
  const status = board.statuses.find(row => row.id === statusId)
  return status ? { statusId, expectedStatusRevision: status.revision } : null
}
export function targetMatches(board: Board, target: StateTarget): boolean {
  const current = targetFor(board, target.statusId)
  return current !== null && current.expectedStatusRevision === target.expectedStatusRevision
}
export function activityCompare(a: Card, b: Card): number { return (b.activityAt ?? b.joinedAt) - (a.activityAt ?? a.joinedAt) || a.sessionId.localeCompare(b.sessionId) }
/** Newest activity first, re-evaluated on every render: a session that just moved
 *  rises to the top of its status column instead of keeping a stale position. */
export function activityOrder(cards: Card[]): Card[] { return [...cards].sort(activityCompare) }
/** Position of the card's status in the configured status order; unset follows every status. */
export function statusPosition(board: Board, card: Card): number {
  const index = board.orders.status.ids.indexOf(bucketId(card, 'status'))
  return index < 0 ? board.orders.status.ids.length : index
}
/** Configured status order first, then newest activity first inside one status. */
export function statusActivityOrder(board: Board, cards: Card[]): Card[] {
  return [...cards].sort((a, b) => statusPosition(board, a) - statusPosition(board, b) || activityCompare(a, b))
}
export function formatTime(value: number | null, active = 'zh', t = defaultTranslator): string { return value === null ? t('noRecord') : new Date(value).toLocaleString(active, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
