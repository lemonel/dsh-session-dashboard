import { useEffect, useRef, useState } from 'react'
import type { Card } from '../shared/model.js'
import { historyPageSchema, type HistoryPage, type HistoryRecord } from '../shared/commands.js'
import { errorMessage, unwrapRemote, type DashboardApi } from './client.js'
import { useDashboardLocale } from './i18n.js'
import { formatTime } from './view-model.js'

export function HistorySection({ api, card }: { api: DashboardApi; card: Card }) {
  const { t, active } = useDashboardLocale()
  const [page, setPage] = useState<HistoryPage | null>(null), [failure, setFailure] = useState<string | null>(null), [loading, setLoading] = useState(false)
  const ticket = useRef(0), mounted = useRef(true)
  const load = async (after?: number) => {
    const current = ++ticket.current
    setLoading(true); setFailure(null)
    try {
      if (!api.history) throw new Error('History unavailable')
      const value = historyPageSchema.parse(unwrapRemote(await api.history({ sessionId: card.sessionId, membershipId: card.membershipId, limit: 100, ...(after === undefined ? {} : { after }) })))
      if (!mounted.current || current !== ticket.current) return
      if (value.sessionId !== card.sessionId || value.membershipId !== card.membershipId) throw new Error('History member mismatch')
      setPage(previous => after === undefined || !previous ? value : { ...value, truncated: previous.truncated || value.truncated, records: [...previous.records, ...value.records.filter(record => !previous.records.some(old => old.id === record.id))] })
    } catch (error) { if (mounted.current && current === ticket.current) setFailure(errorMessage(error, t)) }
    finally { if (mounted.current && current === ticket.current) setLoading(false) }
  }
  useEffect(() => { mounted.current = true; setPage(null); void load(); return () => { mounted.current = false; ticket.current++ } }, [card.sessionId, card.membershipId, card.workflowRevision])
  const kind = (record: HistoryRecord) => t(record.kind === 'legacy_decision' ? 'historyLegacy' : record.kind === 'episode_started' ? 'historyEpisode' : record.kind === 'state_changed' ? 'historyState' : record.kind === 'project_moved' ? 'historyProject' : record.kind === 'accepted' ? 'historyAccepted' : record.kind === 'returned' ? 'historyReturned' : 'historyReopened')
  const snapshotName = (state: NonNullable<HistoryRecord['toState']>): string => 'statusName' in state ? state.statusName : `${state.projectName} · ${state.stateName}`
  const destination = (record: HistoryRecord) => record.to.kind === 'builtin' ? t(record.to.status) : record.to.kind === 'unset' ? t('unsetState') : record.toState ? snapshotName(record.toState) : t('noRecord')
  return <section className="sd-stack"><h3>{t('historyTitle')}</h3><p className="sd-small sd-muted">{t('noActorClaim')}</p>{page?.truncated && <p role="status" className="sd-small">{t('historyTruncated')}</p>}{page?.gap && <p role="alert" className="sd-small sd-error">{t('historyGap')}</p>}{failure && <div role="alert" className="sd-draftbar sd-error"><p>{failure}</p><button onClick={() => { void load() }}>{t('retry')}</button></div>}{page?.records.map(record => <article className="sd-history" key={record.id}><div className="sd-between"><strong>{kind(record)}</strong><span className="sd-small">{formatTime(record.at, active, t)}</span></div><p>{t('episode', { id: record.episodeId ?? t('unknownEpisode') })}</p><p>{t('source', { name: record.origin?.kind === 'state' ? ('statusName' in record.origin.state ? record.origin.state.statusName : `${record.origin.state.projectName} · ${record.origin.state.stateName}`) : t('unspecifiedOrigin') })}</p><p>{t('historyDestination', { name: destination(record) })}</p>{record.kind === 'project_moved' && <p>{record.fromProject?.projectName ?? t('noRecord')} → {record.toProject?.projectName ?? (record.toProjectId === null ? t('unassigned') : t('noRecord'))}</p>}</article>)}{loading && <p role="status">{t('historyLoading')}</p>}{page && !page.records.length && <p>{t('historyEmpty')}</p>}{page?.nextAfter !== null && page && <button disabled={loading} onClick={() => { void load(page.nextAfter ?? undefined) }}>{t('loadMore')}</button>}</section>
}
