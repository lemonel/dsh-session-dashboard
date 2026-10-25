import { useEffect, useId, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Board } from '../shared/model.js'
import { useTranslator } from './i18n.js'
import { NativePageFrame } from './NativePageFrame.js'

/** The Client Session Controller list member, observed without retaining anything. */
export interface SessionListSource { getSnapshot(): SessionListState; subscribe(listener: () => void): () => void }

interface Candidate { sessionId: string; title: string; cwd: string | null }

/** Create a Session in the host's own New Session UI. The dashboard only watches
 *  the Client list for a Session that leaves `blank` (or appears already started)
 *  and then asks whether to add it; it never joins or navigates automatically.
 *
 *  The frame reuses the same floating native window as the preview (`1000px` wide,
 *  `min(74vh, 680px)` of native page, `92vh` cap) instead of a full-screen shell.
 *  Detection is subscription-driven: the Client Session Controller republishes
 *  `api-session/added`, `removed`, `status` and `activity` through this list, so
 *  the overlay never asks the controller to re-read the whole catalogue. */
export function OfficialCreateOverlay({ projectId, board, frameUrl, sessionList, onJoin, onClose }: {
  projectId: string
  board: Board
  frameUrl: string
  sessionList: SessionListSource
  onJoin: (sessionId: string, displayTitle: string) => void
  onClose: () => void
}) {
  const t = useTranslator(), titleId = useId()
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const candidateRef = useRef<Candidate | null>(null)
  const baseline = useRef(new Map<string, boolean>())
  const prompted = useRef(new Set<string>())
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close.current() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    let active = true
    // Baseline every known row; only a later false transition (or a new already
    // started row) is a candidate. Subagents never become project cards here.
    try {
      const initial = sessionList.getSnapshot()
      for (const id of initial.ids) { const row = initial.byId[id]; if (row) baseline.current.set(String(id), row.blank) }
    } catch { /* a missing list simply never reports a candidate */ }
    const scan = () => {
      if (!active || candidateRef.current) return
      let snapshot: SessionListState
      try { snapshot = sessionList.getSnapshot() } catch { return }
      for (const id of snapshot.ids) {
        const key = String(id), row = snapshot.byId[id]
        if (!row || row.origin === 'subagent' || row.parentId) continue
        if (baseline.current.has(key)) {
          if (baseline.current.get(key) === false) continue
          if (row.blank) continue
        } else {
          // A row first seen blank is ignored now but watched afterwards; a row
          // that arrives already started is a candidate immediately.
          baseline.current.set(key, row.blank)
          if (row.blank) continue
        }
        if (prompted.current.has(key)) continue
        prompted.current.add(key)
        const next: Candidate = { sessionId: key, title: row.displayTitle || key, cwd: row.cwd ?? null }
        candidateRef.current = next
        setCandidate(next)
        return
      }
    }
    // The subscription is the detection path: a Session created or started in the
    // host frame arrives as an `api-session/added`, `status` or `activity`
    // publication, and the controller has already updated this exact projection.
    const unsubscribe = sessionList.subscribe(scan)
    // A one-second re-read of the cached snapshot only covers delivery timing; it
    // never calls the controller's refresh, which would re-summarize every Session.
    const interval = window.setInterval(scan, 1000)
    scan()
    return () => { active = false; candidateRef.current = null; unsubscribe(); window.clearInterval(interval) }
  }, [sessionList])
  const currentCard = candidate ? board.cards.find(card => card.sessionId === candidate.sessionId) ?? null : null
  const projectName = board.projects.find(project => project.id === projectId)?.name ?? t('unassigned')
  const currentName = currentCard?.projectId ? board.projects.find(project => project.id === currentCard.projectId)?.name ?? t('unassigned') : t('unassigned')
  const sameProject = currentCard?.projectId === projectId
  const skip = () => { candidateRef.current = null; setCandidate(null) }
  return <div className="sd-official-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <section className="sd-official">
      <header className="sd-official-head">
        <div className="sd-stack" style={{ gap: 2 }}>
          <h2 id={titleId}>{t('officialCreateTitle')}</h2>
          <p className="sd-small sd-muted">{t('officialCreateHint')}</p>
        </div>
        <button type="button" className="sd-icon-btn" aria-label={t('officialCreateClose')} onClick={onClose}>×</button>
      </header>
      <NativePageFrame src={frameUrl} title={t('officialCreateFrameLabel')} ariaLabel={t('officialCreateFrameLabel')}/>
      <footer className="sd-official-foot">
        {candidate ? <section className="sd-official-confirm" aria-label={t('officialCreateDetected')}>
          <h3>{t('officialCreateDetected')}</h3>
          <p><strong>{candidate.title}</strong></p>
          <p className="sd-small sd-muted">{candidate.cwd ? t('officialCreateCwd', { path: candidate.cwd }) : t('noWorkspace')}</p>
          {sameProject ? <p role="status">{t('officialCreateAlready')}</p> : <>
            {currentCard && <p role="alert">{t('officialCreateMove', { current: currentName, target: projectName })}</p>}
            <div className="sd-row">
              <button type="button" className="sd-primary" onClick={() => onJoin(candidate.sessionId, candidate.title)}>{currentCard ? t('officialCreateMoveAction') : t('officialCreateJoin')}</button>
              <button type="button" onClick={skip}>{t('officialCreateSkip')}</button>
            </div>
          </>}
        </section> : <p role="status">{t('officialCreateWaiting')}</p>}
      </footer>
    </section>
  </div>
}
