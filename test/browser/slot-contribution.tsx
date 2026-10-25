import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { withContributionBoundary } from '@hsx/dsh-session-dashboard/slots'
import type { DashboardCardOwner, DashboardGlobalOwner } from '@hsx/dsh-session-dashboard/slots'

/** A separate fixture plugin consumes only the published slot entry, never core UI internals. */
export function createSlotProbe(ctx: Context) {
  const namespace = '@fixture/dashboard-enhancement'
  let version = 0
  let marker = 'initial'
  let failingSession: string | null = null
  let mounted = false
  let injectCalls = 0
  let mountCount = 0
  let unmountCount = 0
  let disposers: Array<() => void> = []
  let stopOwner: (() => void) | null = null
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getSnapshot = () => version
  const publish = () => { version++; for (const listener of listeners) listener() }
  const useVersion = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  function Badge({ card, occurrenceId }: DashboardCardOwner) {
    useVersion()
    const [local, setLocal] = useState(0)
    useEffect(() => { mountCount++; return () => { unmountCount++ } }, [])
    if (card.sessionId === failingSession) throw new Error('Intentional isolated contribution failure')
    return <span data-probe-badge data-probe-session={card.sessionId} data-probe-occurrence={occurrenceId} data-probe-member={card.membershipId}>
      <span>{marker} · {card.title} · {card.status}</span>
      <button type="button" aria-label={`Probe local ${occurrenceId}`} onClick={() => setLocal(value => value + 1)}>{local}</button>
    </span>
  }
  function Menu({ card, occurrenceId, actions }: DashboardCardOwner) {
    return <button type="button" data-probe-menu data-probe-occurrence={occurrenceId} aria-label={`Probe details ${occurrenceId}`} onClick={() => { void actions.openDetails() }}>{card.title}增强详情</button>
  }
  // The per-card badge slot is no longer rendered by the overview, so the detail
  // section is the surviving card contribution that proves the inner boundary.
  function Detail({ card }: DashboardCardOwner) {
    if (card.sessionId === failingSession) throw new Error('Intentional isolated contribution failure')
    return <section data-probe-detail><h3>只读增强报告</h3><p>{card.title} · {card.phase}</p></section>
  }
  function Toolbar({ context }: DashboardGlobalOwner) { return <button type="button" data-probe-toolbar>增强工具 · {context.handshake ? 'ready' : 'waiting'}</button> }
  function Summary({ context }: DashboardGlobalOwner) { return <p data-probe-summary>增强唯一会话数 {context.uniqueVisible}</p> }

  const unregister = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
  const register = () => {
    unregister()
    disposers = [
      ctx.slots.register({ name: 'session-dashboard.toolbar.action', id: `${namespace}:toolbar`, order: 40 }, Toolbar),
      ctx.slots.register({ name: 'session-dashboard.summary.widget', id: `${namespace}:summary`, order: 40 }, Summary),
      ctx.slots.register({ name: 'session-dashboard.card.badge', id: `${namespace}:badge`, order: 40, inject: () => { injectCalls++; return {} } }, withContributionBoundary(`${namespace}:badge`, Badge)),
      ctx.slots.register({ name: 'session-dashboard.card.menu.item', id: `${namespace}:menu`, order: 40 }, withContributionBoundary(`${namespace}:menu`, Menu)),
      ctx.slots.register({ name: 'session-dashboard.detail.section', id: `${namespace}:detail`, order: 40 }, withContributionBoundary(`${namespace}:detail`, Detail)),
    ]
  }
  return {
    async mount() {
      if (mounted) return
      mounted = true
      // The SDK collapses child registrations when main is disposed. The extension
      // observes the public declaring-main lifecycle and explicitly re-registers.
      stopOwner = ctx.slots.subscribe('main', () => {
        if (!mounted) return
        if (ctx.slots.entries('main').some(entry => entry.options.key === 'session-dashboard')) register()
        else unregister()
      })
      register()
    },
    async dispose() {
      if (!mounted) return
      mounted = false; stopOwner?.(); stopOwner = null; unregister()
      failingSession = null; marker = 'initial'; publish()
    },
    snapshot() {
      return { mounted, injectCalls, mountCount, unmountCount,
        registrations: ctx.slots.entries('session-dashboard.card.badge').length,
        projections: ctx.slots.entriesOfSlot('session-dashboard.card.badge').length }
    },
    failSession(id: string | null) { failingSession = id; publish() },
    setMarker(value: string) { marker = value; publish() },
  }
}
