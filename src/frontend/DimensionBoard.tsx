import { useState, type ReactNode } from 'react'
import type { Board, Card } from '../shared/model.js'
import type { GroupBucket } from './board-dimensions.js'
import { useTranslator } from './i18n.js'
import type { RowActionHandlers } from './RowActions.js'
import { CaretIcon } from './Popover.js'
import { SessionRow } from './SessionRow.js'

/** Value cards for a non-project dimension: one card per value (a status, a tag, the
 *  unset remainder), each holding that value's sessions. Projects keep their own grid
 *  because they also carry creation, drag and reorder; here the card is read-only
 *  except for the session rows themselves. */
export function DimensionBoard({ board, dimension, buckets, onPreview, onChangeState, onReviewState, actions, facets, badge, menu }: {
  board: Board
  dimension: string
  buckets: GroupBucket[]
  onPreview: (card: Card) => void
  onChangeState?: (card: Card, statusId: string | null) => void | Promise<void>
  onReviewState?: (card: Card, statusId: string | null) => void | Promise<void>
  actions?: RowActionHandlers
  facets?: (card: Card) => ReactNode
  badge?: (card: Card, occurrence: string) => ReactNode
  menu?: (card: Card, occurrence: string) => ReactNode
}) {
  const t = useTranslator()
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) => setClosed(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  return <div className="sd-valuegrid" data-dimension={dimension}>
    {buckets.map(bucket => {
      const open = !closed.has(bucket.key), regionId = `sd-value-sessions-${bucket.key}`
      const label = `${bucket.name} · ${t('membersCount', { count: bucket.cards.length })}`
      return <article key={bucket.key} className="sd-projectcard sd-valuecard" aria-label={bucket.name} data-value-key={bucket.key} data-expanded={open ? 'true' : undefined}
        onClick={event => { const target = event.target as HTMLElement; if (target.closest('button') || target.closest('.sd-pop') || target.closest('.sd-statepanel') || target.closest('.sd-projectdrop') || target.closest('.sd-facet') || target.closest('.sd-facet-wrap') || target.closest('.sd-facet-panel')) return; toggle(bucket.key) }}>
        <div className="sd-projectcard-head">
          <h3>
            <button type="button" className="sd-projecttoggle" aria-expanded={open} aria-controls={regionId} title={bucket.name} onClick={() => toggle(bucket.key)}>
              <CaretIcon className="sd-projecttoggle-caret"/>
              {bucket.color !== null && <span className="sd-dot" style={{ background: bucket.color }} aria-hidden="true"/>}
              <span className="sd-projectname">{bucket.name}</span>
            </button>
          </h3>
          <p className="sd-projectstats"><b>{t('membersCount', { count: bucket.cards.length })}</b></p>
        </div>
        {open && <div className="sd-projectdrop" id={regionId} role="region" aria-label={label} tabIndex={-1} data-value-drop={bucket.key}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosed(current => new Set(current).add(bucket.key)) } }}>
          <div className="sd-projectdrop-list">{bucket.cards.map(card => <SessionRow key={card.membershipId} board={board} card={card} onPreview={onPreview} onChangeState={onChangeState} onReviewState={onReviewState} actions={actions} facets={facets} badge={badge} menu={menu}/>)}</div>
        </div>}
      </article>
    })}
  </div>
}
