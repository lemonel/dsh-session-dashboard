import { useState, type DragEvent } from 'react'
import type { Card } from '../shared/model.js'
import { displayTitle } from '../shared/model.js'
import { running } from './view-model.js'
import { Popover } from './Popover.js'
import { useDashboardLocale } from './i18n.js'

/** What a row action reports back: a failed action keeps the row's input and
 *  shows the server's reason instead of silently dropping the edit. */
export interface RowActionOutcome { ok: boolean }
export interface RowActionHandlers {
  onTitle: (card: Card, title: string) => Promise<RowActionOutcome>
  onArchive: (card: Card, archived: boolean) => Promise<RowActionOutcome>
  onFork: (card: Card) => Promise<RowActionOutcome>
  /** Dragging this grip carries the tracked payload to a project card; the row never writes a project move itself. */
  onMoveDrag?: (card: Card, event: DragEvent<HTMLButtonElement>) => void
  /** Opens the session details drawer; the row's title keeps its own preview semantics. */
  onDetails?: (card: Card) => void
  /** Enters the native DSH session (the row title previews it instead). */
  onEnter?: (card: Card) => void
  /** Row failures live in the dashboard toast stack, never in the row layout. */
  report: (message: string) => void
}

/** Title, inline rename and the rare row actions shared by project rows and the
 *  review/attention/archive lists. The menu trigger is always visible and tabbable,
 *  so none of these actions hides behind hover. */
export function SessionRowHead({ card, titleClassName, onOpen, actions }: {
  card: Card
  titleClassName: string
  onOpen: () => void
  actions?: RowActionHandlers
}) {
  const { t } = useDashboardLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const archived = card.archivedAt !== null
  /** The title the row currently shows; renaming starts from it, not from a blank box. */
  const currentTitle = card.titleOverride ?? (card.hostTitle || card.sessionId)
  const run = async (work: () => Promise<RowActionOutcome>): Promise<boolean> => {
    setPending(true)
    try { return (await work()).ok } catch { actions?.report(t('rowActionFailed')); return false } finally { setPending(false) }
  }
  const saveTitle = async (): Promise<void> => {
    if (!actions) return
    // An unchanged title is not a write: close the editor without touching the native session.
    if (draft.trim() === currentTitle.trim()) { setEditing(false); return }
    if (await run(() => actions.onTitle(card, draft))) setEditing(false)
  }
  const beginArchive = (): void => {
    if (!actions) return
    if (!archived && running(card)) { setConfirmArchive(true); return }
    void run(() => actions.onArchive(card, !archived))
  }
  return <div className="sd-rowhead">
    {actions?.onMoveDrag && <button type="button" className="sd-projectgrip sd-rowgrip" draggable={!(pending || editing || archived)} disabled={pending || editing || archived}
      aria-label={archived ? t('rowMoveArchived') : t('rowMoveDrag', { title: displayTitle(card) })}
      title={archived ? t('rowMoveArchived') : t('rowMoveDrag', { title: displayTitle(card) })}
      onDragStart={event => { if (pending || editing || archived) { event.preventDefault(); return } actions?.onMoveDrag?.(card, event) }}>
      <span aria-hidden="true">⠿</span>
    </button>}
    {editing
      ? <form className="sd-rowedit" onSubmit={event => { event.preventDefault(); void saveTitle() }}>
        <input autoFocus aria-label={t('renameInput', { title: displayTitle(card) })} value={draft} maxLength={160} disabled={pending} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); void saveTitle(); return }
            if (event.key !== 'Escape') return
            event.preventDefault(); setEditing(false)
          }}/>
        <button type="submit" className="sd-small" disabled={pending}>{t('saveLabel')}</button>
        <button type="button" className="sd-small" onClick={() => setEditing(false)}>{t('cancel')}</button>
      </form>
      : <button type="button" className={titleClassName} onClick={onOpen}>{displayTitle(card)}</button>}
    {actions && <Popover label={t('rowActions', { title: displayTitle(card) })} closeOnSelect>
      {actions.onEnter && <button type="button" className="sd-menu-item" disabled={pending || editing || archived} title={archived ? t('hostArchiveGuide') : undefined} onClick={() => actions.onEnter?.(card)}>{t('enterSession')}</button>}
      {actions.onDetails && <button type="button" className="sd-menu-item" disabled={pending || editing} onClick={() => actions.onDetails?.(card)}>{t('sessionDetails')}</button>}
      <button type="button" className="sd-menu-item" disabled={pending || editing} onClick={() => { setDraft(currentTitle); setEditing(true) }}>{t('renameSession')}</button>
      <button type="button" className="sd-menu-item" disabled={pending || archived} title={archived ? t('rowForkArchived') : undefined} onClick={() => { void run(() => actions.onFork(card)) }}>{t('forkSession')}</button>
      <button type="button" className="sd-menu-item" disabled={pending} onClick={beginArchive}>{archived ? t('restoreBoard') : t('archiveButton')}</button>
    </Popover>}
    {confirmArchive && <div className="sd-rowconfirm" role="alert">
      <p className="sd-small">{t('rowArchiveRunningConfirm')}</p>
      <div className="sd-row"><button type="button" className="sd-small" disabled={pending} onClick={() => { if (!actions) return; setConfirmArchive(false); void run(() => actions.onArchive(card, true)) }}>{t('confirmArchive')}</button><button type="button" className="sd-small" onClick={() => setConfirmArchive(false)}>{t('cancel')}</button></div>
    </div>}
  </div>
}
