import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DashboardClient } from './client.js'

type DashboardTranslate = TranslateNS<'sessionDashboard'>

/** rc.2 has no public session-list filter slot. This places one filter control
 *  beside the native view-options button and hides matching row-key nodes; it
 *  never edits the native store or session list. */
export function registerSidebarMembershipFilter(client: DashboardClient, t: DashboardTranslate): () => void {
  const FILTER_ATTR = 'data-session-dashboard-filter'
  const MEMBER_ATTR = 'data-session-dashboard-member'
  let button: HTMLButtonElement | null = null
  let members = new Set<string>()
  let scheduled = false

  const syncRows = () => {
    scheduled = false
    if (typeof document === 'undefined') return
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')) {
      const id = row.getAttribute('data-row-key')?.slice('session:'.length) ?? ''
      if (members.has(id)) row.setAttribute(MEMBER_ATTR, 'true')
      else row.removeAttribute(MEMBER_ATTR)
    }
  }
  const scheduleRows = () => { if (scheduled) return; scheduled = true; (typeof queueMicrotask === 'function' ? queueMicrotask : (work: () => void) => setTimeout(work, 0))(syncRows) }

  const filterButton = (): HTMLButtonElement | null => {
    if (typeof document === 'undefined') return null
    const anchor = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar"] button[aria-label]')]
      .find(node => /^(视图选项|View options)$/.test(node.getAttribute('aria-label') ?? ''))
    if (!anchor) return null
    const existing = anchor.parentElement?.querySelector<HTMLButtonElement>(`button[${FILTER_ATTR}]`)
    if (existing) return existing
    const node = document.createElement('button')
    node.type = 'button'
    node.className = anchor.className
    node.setAttribute(FILTER_ATTR, 'true')
    node.setAttribute('aria-label', t('excludeDashboard'))
    node.title = t('excludeDashboardHint')
    node.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14l-5.5 6v4l-3-1.5V11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    node.addEventListener('click', () => {
      const on = document.documentElement.dataset.sessionDashboardExclude === 'true'
      if (on) delete document.documentElement.dataset.sessionDashboardExclude
      else document.documentElement.dataset.sessionDashboardExclude = 'true'
      node.setAttribute('aria-pressed', on ? 'false' : 'true')
      scheduleRows()
    })
    anchor.parentElement?.insertBefore(node, anchor)
    return node
  }

  const sync = () => {
    button = filterButton()
    const exclude = document.documentElement.dataset.sessionDashboardExclude === 'true'
    if (button) button.setAttribute('aria-pressed', exclude ? 'true' : 'false')
    scheduleRows()
  }
  const unsubscribe = client.subscribe(() => {
    const board = client.getSnapshot().snapshot?.board
    members = new Set(board?.cards.map(card => card.sessionId) ?? [])
    scheduleRows()
  })
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => sync())
  observer?.observe(document.body, { childList: true, subtree: true })
  const board = client.getSnapshot().snapshot?.board
  members = new Set(board?.cards.map(card => card.sessionId) ?? [])
  sync()

  return () => {
    unsubscribe()
    observer?.disconnect()
    button?.remove()
    delete document.documentElement.dataset.sessionDashboardExclude
    for (const row of document.querySelectorAll(`[${MEMBER_ATTR}]`)) row.removeAttribute(MEMBER_ATTR)
  }
}
