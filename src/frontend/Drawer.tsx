import type { ReactNode } from 'react'
import { displayTitle } from '../shared/model.js'
import type { Board, Card } from '../shared/model.js'
import { bindingMatches, formatTime, originText, projectTags, reviewBinding, runtimeGuidance, runtimeText, valueText } from './view-model.js'
import { dirtyDraft, dirtyFields, type CardDraft, type EditorState } from './editor.js'
import { Modal } from './Modal.js'
import { ArchiveBadge } from './ArchiveBadge.js'
import { StatusChip } from './StateControl.js'
import { useDashboardLocale } from './i18n.js'
import { HistorySection } from './HistorySection.js'
import type { DashboardApi } from './client.js'

/** The session drawer: one session's facts and the one thing only it can do —
 *  record a one-line progress note. Everything the row
 *  already owns (rename, archive, state, project, tags, entering the session) is
 *  deliberately not repeated here: two entry points for one write made the same
 *  action behave differently depending on where it was clicked. */
export function Drawer({ extension, api, board, card, editor, busy, ready, onChange, onClose, onSave, onReload, onRebind, onRebaselineSource, onResync }: {
  extension?: ReactNode
  api?: DashboardApi
  board: Board
  card: Card
  editor: EditorState
  busy: boolean
  ready: boolean
  onChange: (draft: CardDraft) => void
  onClose: () => void
  onSave: () => void
  onReload: () => void
  onRebind: () => void
  onRebaselineSource: () => void
  onResync: () => void
}) {
  const { t, active } = useDashboardLocale(), draft = editor.draft
  // Same-run syncs move lifecycle/workflow revisions; keep the open drawer armed.
  // A new episode leaves the old binding in place and still requires a re-check.
  const actionBinding = card.runtime.episodeId === editor.binding.episodeId ? reviewBinding(card) : editor.binding
  const archived = card.archivedAt !== null, conflict = draft.baseRevision !== card.metadataRevision || draft.membershipId !== card.membershipId, stale = !bindingMatches(card, actionBinding)
  const tags = projectTags(board, card), guidance = runtimeGuidance(card, t)
  // One value per group: a radio row per group (ungrouped tags share one implicit
  // group) plus the project's inherited tags shown above as read-only.
  const ungrouped = board.tags.filter(tag => tag.groupId === null)
  const tagGroups = [
    ...board.tagGroups.map(group => ({ id: group.id as string | null, name: group.name, tags: board.tags.filter(tag => tag.groupId === group.id) })).filter(group => group.tags.length > 0),
    ...ungrouped.length > 0 ? [{ id: null, name: t('ungroupedTags'), tags: ungrouped }] : [],
  ]
  const mergedDraftTags = [...new Set([...draft.tagIds, ...tags])]
  return <Modal title={t('sessionDetails')} drawer onClose={onClose} busy={busy} originId={card.sessionId}>
    <div className="sd-stack">
      <div className="sd-stack" style={{ gap: 'var(--sd-1)' }}><h3>{displayTitle(card)}</h3><p className="sd-small sd-muted">{card.workspace || t('noWorkspace')} · {t('detailsWorkspaceHint')}</p></div>
      <div className="sd-row"><StatusChip board={board} card={card}/><span className="sd-runtime" data-warning={card.runtime.sync !== 'synced'}>{runtimeText(card, t)}</span><ArchiveBadge value={card.hostArchive} showActive/>{archived && <span className="sd-badge">{t('boardArchived')}</span>}</div>
      <p className="sd-small">{t('source', { name: originText(card, t) })} <button type="button" className="sd-small" disabled={busy} onClick={onRebaselineSource} title={t('rebaselineSourceHint')}>{t('rebaselineSource')}</button></p>
    </div>
    {card.hostArchive.state !== 'active' && <div className="sd-draftbar" role="status"><p>{t(card.hostArchive.state === 'archived' ? 'hostArchiveGuide' : 'hostUnknownJoin')}</p><p>{t('hostArchiveSafety')}</p></div>}
    {(!ready || card.runtime.sync !== 'synced' || !card.runtime.sourceLive) && <div className="sd-draftbar"><p>{t('coldSafety')}</p><button onClick={onResync} disabled={busy}>{t('resyncSession')}</button></div>}
    {guidance && <div className="sd-draftbar" aria-label={t('runtimeGuidance')}>{guidance.explanation && <p className="sd-small">{guidance.explanation}</p>}<p>{guidance.nextStep}</p></div>}
    {archived && <p className="sd-draftbar">{t('archivedReadOnly')}</p>}{conflict && <div className="sd-draftbar" role="status"><p>{t('metadataConflict')}</p><button disabled={busy} onClick={onReload}>{t('reloadFields')}</button><p>{t('copyBeforeReload')}</p></div>}
    <div className="sd-stack">
      <label className="sd-formfield"><span>{t('progressLabel')}</span><textarea aria-label={t('progress')} rows={3} maxLength={500} value={draft.progress} placeholder={t('progressPlaceholder')} disabled={archived || busy} onChange={event => onChange({ ...draft, progress: event.target.value })}/><small>{t('progressHint', { count: draft.progress.length })}</small></label>
    </div>
    {!archived && <div className="sd-draftbar sd-between"><span>{t(dirtyDraft(draft) ? 'dirtyHint' : 'fieldsSaved')}</span><button className="sd-primary" disabled={busy || conflict || !dirtyFields(draft)} onClick={onSave}>{t('saveFields')}</button></div>}
    <section className="sd-stack">
      <h3>{t('tagOrigin')}</h3>{mergedDraftTags.length > 0 && <div className="sd-row">{mergedDraftTags.map(id => <span className="sd-tag" key={id}>{valueText(board, 'tag', id, t)} · {t(tags.includes(id) && draft.tagIds.includes(id) ? 'sourceBoth' : tags.includes(id) ? 'sourceProject' : 'sourceOwn')}</span>)}</div>}
      <p className="sd-small">{t('managePublicTags')}</p>
      {tagGroups.map(group => <div className="sd-taggroup" key={group.id ?? 'ungrouped'}>
        <span className="sd-small sd-muted">{group.name}</span>
        <div className="sd-row" role="radiogroup" aria-label={group.name}>
          {group.tags.length === 0 && <span className="sd-small sd-muted">{t('noChoices', { title: group.name })}</span>}
          {group.tags.map(tag => {
            const selected = draft.tagIds.includes(tag.id)
            return <button type="button" key={tag.id} role="radio" aria-checked={selected} className="sd-tagchoice" data-selected={selected ? 'true' : undefined}
              disabled={archived || busy}
              onClick={() => onChange({ ...draft, tagIds: selected ? draft.tagIds.filter(id => id !== tag.id) : [...draft.tagIds.filter(id => !group.tags.some(row => row.id === id)), tag.id] })}>{tag.name}</button>
          })}
        </div>
      </div>)}
      {tagGroups.length > 0 && <p className="sd-small sd-muted">{t('tagSingleHint')}</p>}
    </section>
    <hr className="sd-divider"/>
    <section className="sd-stack"><h3>{t('roundProgress')}</h3><p className="sd-small">{t('runEnded', { time: formatTime(card.reviewAt ?? card.runtime.endedAt, active, t) })}<br/>{t('acceptedTime', { time: formatTime(card.acceptedAt, active, t) })}<br/>{t('episode', { id: editor.binding.episodeId ?? t('unknownEpisode') })}</p>{stale && <div className="sd-draftbar"><p role="status">{t('confirmStale')}</p><button disabled={busy} onClick={onRebind}>{t('rebind')}</button></div>}
    </section>
    {api && <HistorySection api={api} card={card}/>}
{extension}
  </Modal>
}
