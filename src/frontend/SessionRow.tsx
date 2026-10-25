import type { ReactNode } from 'react'
import type { Board, Card } from '../shared/model.js'
import { effectiveTags } from './view-model.js'
import { ArchiveBadge } from './ArchiveBadge.js'
import { RunningElapsed } from './Elapsed.js'
import { useDashboardLocale } from './i18n.js'
import { SessionRowHead, type RowActionHandlers } from './RowActions.js'
import { StateControl } from './StateControl.js'
import { attentionDetail, attentionLabel, attentionTone, formatTime, runningElapsedStart, terminalOutcome, valueText } from './view-model.js'

/** One session inside a group tile (a project card, or any other dimension's value
 *  card): compact, readable at panel width. The title owns the preview entry point;
 *  details live behind the row's own menu. */
export function SessionRow({ board, card, onPreview, onChangeState, onReviewState, actions, facets, badge, menu }: {
  board: Board
  card: Card
  onPreview: (card: Card) => void
  onChangeState?: (card: Card, statusId: string | null) => void | Promise<void>
  onReviewState?: (card: Card, statusId: string | null) => void | Promise<void>
  actions?: RowActionHandlers
  facets?: (card: Card) => ReactNode
  badge?: (card: Card, occurrence: string) => ReactNode
  menu?: (card: Card, occurrence: string) => ReactNode
}) {
  const { t, active } = useDashboardLocale(), tags = effectiveTags(board, card)
  // The row hides the chip's own label to keep 128px, so the concrete system outcome
  // (interrupted / failed / stopped) gets its own short visible label here.
  // A terminal system result is already the chip's own text, so the row does not
  // repeat it; other attention (input/approval/resume/sync) still gets its label.
  const mark = terminalOutcome(card) === null ? attentionLabel(card, t) : null, markDetail = attentionDetail(card, t)
  const elapsedStart = runningElapsedStart(card), rowTime = formatTime(card.activityAt ?? card.joinedAt, active, t)
  return <article className="sd-projectrow" data-card-id={card.sessionId}>
    <SessionRowHead card={card} titleClassName="sd-projectrow-title" onOpen={() => onPreview(card)} actions={actions}/>
    <div className="sd-row sd-small sd-muted">
      <StateControl board={board} card={card} onChangeState={onChangeState} onReviewState={onReviewState} />{mark && <span className="sd-attentioninline" data-tone={attentionTone(card) ?? undefined} title={t('attentionMarkTitle', { reason: markDetail ?? mark })}>{mark}</span>}{facets?.(card)}{badge?.(card, `row:${card.membershipId}`)}
      <span>· {elapsedStart === null ? rowTime : <RunningElapsed startedAt={elapsedStart} text={time => t('elapsedRunning', { time })} title={t('elapsedHint', { start: formatTime(elapsedStart, active, t), last: rowTime })}/>}</span>
    </div>
    {card.progress && <p className="sd-small sd-muted sd-projectrow-progress">{card.progress}</p>}
    <div className="sd-row"><ArchiveBadge value={card.hostArchive}/>{tags.slice(0, 3).map(id => <span className="sd-tag" key={id}>{valueText(board, 'tag', id, t)}</span>)}{tags.length > 3 && <span className="sd-small sd-muted">+{tags.length - 3}</span>}{menu?.(card, `row:${card.membershipId}`)}</div>
  </article>
}
