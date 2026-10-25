import { Component, createElement, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { useTranslator } from './i18n.js'
import type { Translator } from './i18n.js'
import type { DashboardSlot } from '../shared/slots.js'

export const dashboardChildren = {
  'session-dashboard.toolbar.action': { kind: 'list', scope: 'root' },
  'session-dashboard.summary.widget': { kind: 'list', scope: 'root' },
  'session-dashboard.card.badge': { kind: 'list', scope: 'root' },
  'session-dashboard.card.facet': { kind: 'list', scope: 'root' },
  'session-dashboard.card.menu.item': { kind: 'list', scope: 'root' },
  'session-dashboard.detail.section': { kind: 'list', scope: 'root' },
} as const satisfies Record<DashboardSlot, { kind: 'list'; scope: 'root' }>

interface BoundaryProps { id: string; children: ReactNode; t: Translator }
interface BoundaryState { failed: boolean; attempts: number }
class ContributionBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, attempts: 0 }
  static getDerivedStateFromError(): Partial<BoundaryState> { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnostics exclude card text, reports, logs and credentials.
    console.warn(`Dashboard contribution ${this.props.id} failed`, error.name, Boolean(info.componentStack))
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return createElement('span', { role: 'status' }, this.props.t('enhancementUnavailable'), ' ', this.state.attempts < 2
      ? createElement('button', { type: 'button', onClick: () => this.setState(state => ({ failed: false, attempts: state.attempts + 1 })) }, this.props.t('retryEnhancement'))
      : this.props.t('reloadEnhancement'))
  }
}
/** Boundary is INSIDE the framework contribution: one occurrence's subtree failure
 * cannot abdicate every projection. Hook injection/registration failures remain SDK-level
 * failures and require the registrant's diagnostics and dispose/re-register recovery. */
export function withContributionBoundary<P extends object>(id: string, Body: ComponentType<P>): (props: P) => ReactNode {
  if (!/^@[^/]+\/[a-z0-9._-]+[:/][a-z0-9._-]+$/i.test(id)) throw new Error('贡献 ID 必须带包命名空间和局部身份')
  return props => { const t = useTranslator(); return createElement(ContributionBoundary, { id, t, children: createElement(Body, props) }) }
}
