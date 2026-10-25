import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DashboardError, errorText, type NavigationQuery, type NavigationResult, type CandidatePage, type CandidateQuery, type Mutation, type InspectionQuery, type SessionInspection, type HistoryQuery, type HistoryPage } from '../shared/commands.js'
import { browserAuthorizationFence } from './compat.js'
import type { Snapshot } from '../shared/model.js'
import type { DashboardService } from './service.js'
import type { DashboardExtensions } from './extensions.js'
import type { DashboardHandshake, PublicQuery, EventQuery, PublicSnapshot, EventPage } from '../shared/extension.js'
import type { Transcript, TranscriptQuery } from '../shared/transcript.js'

/** Only the host's exact authenticated browser operator may use board RPC.
 * Version-specific identity checks live in the compatibility boundary. */
export class SessionDashboardRemote extends TypertRemoteService {
  private readonly log = this.ctx.logger('session-dashboard')
  constructor(ctx: Context, private readonly dashboard: DashboardService, private readonly extensions?: DashboardExtensions) { super(ctx, 'sessionDashboard', { namespace: 'sessionDashboard' }) }
  /** Every RPC funnels through one fence and one place that reports it: the browser
   *  still receives the structured failure, and the host log keeps why it happened. */
  private async call<T>(name: string, work: (fence: () => void) => Promise<T>): Promise<T> {
    try { return await work(browserAuthorizationFence(this.ctx)) }
    catch (error) {
      if (error instanceof DashboardError) this.log.warn('RPC %s 被拒绝：%s', name, error.code)
      else this.log.error('RPC %s 失败', name, error)
      if (error instanceof DashboardError) throw new RemoteError('dashboard/error', error.message, { reason: error.code, ...(error.messageKey ? { messageKey: error.messageKey } : {}), ...(error.params ? { params: { ...error.params } } : {}) })
      throw new RemoteError('dashboard/error', errorText(error), { reason: 'INVALID' })
    }
  }
  @Remote
  handshake(): Promise<DashboardHandshake> { return this.call('handshake', async fence => { fence(); if (!this.extensions) throw new DashboardError('UNAVAILABLE', '扩展服务未装配'); return this.extensions.handshake() }) }
  @Remote
  extensionSnapshot(query: PublicQuery): Promise<PublicSnapshot> { return this.call('extensionSnapshot', fence => { if (!this.extensions) throw new DashboardError('UNAVAILABLE', '扩展服务未装配'); return this.extensions.snapshot(query, fence) }) }
  @Remote
  extensionEvents(query: EventQuery): Promise<EventPage> { return this.call('extensionEvents', async fence => { if (!this.extensions) throw new DashboardError('UNAVAILABLE', '扩展服务未装配'); return this.extensions.events(query, fence) }) }
  @Remote
  navigation(query: NavigationQuery): Promise<NavigationResult> { return this.call('navigation', fence => this.dashboard.navigation(query, fence)) }
  @Remote
  snapshot(): Promise<Snapshot> { return this.call('snapshot', fence => this.dashboard.snapshot(fence)) }
  @Remote
  candidates(query: CandidateQuery): Promise<CandidatePage> { return this.call('candidates', fence => this.dashboard.candidates(query, fence)) }
  @Remote
  inspectSession(query: InspectionQuery): Promise<SessionInspection> { return this.call('inspectSession', fence => this.dashboard.inspectSession(query, fence)) }
  @Remote
  history(query: HistoryQuery): Promise<HistoryPage> { return this.call('history', fence => this.dashboard.history(query, fence)) }
  @Remote
  transcript(query: TranscriptQuery): Promise<Transcript> { return this.call('transcript', fence => this.dashboard.transcript(query, fence)) }
  @Remote
  mutate(mutation: Mutation): Promise<Snapshot> { return this.call('mutate', fence => this.dashboard.mutate(mutation, fence)) }
}
