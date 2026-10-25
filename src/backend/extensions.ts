import { Service, symbols, type Context } from '@deepseek-ai/cordis'
import { DASHBOARD_API_VERSION, publicQuerySchema, eventQuerySchema, handshakeSchema, publicSnapshotSchema, eventPageSchema, type DashboardExtensionService, type DashboardHandshake, type DashboardReadLease, type EventPage, type EventQuery, type PublicQuery, type PublicSnapshot } from '../shared/extension.js'
import { fail } from '../shared/commands.js'
import type { DashboardService } from './service.js'
import type { BoardStore } from './store.js'

function assertApiVersion(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('apiVersion' in value) || value.apiVersion !== DASHBOARD_API_VERSION) {
    fail('UNSUPPORTED_API', 'Dashboard API v2 is required; API v1 cannot represent custom states or inherited tags.', 'errors.unsupportedApi')
  }
}

/** Trusted in-process readonly service. Cordis binds real calling Context lifetime;
 * a self-reported identity can neither impersonate a user nor grant mutation access. */
export class DashboardExtensions extends Service implements DashboardExtensionService {
  private active = true
  private readonly owner: Context
  constructor(ctx: Context, private readonly store: BoardStore, private readonly dashboard: DashboardService) {
    super(ctx, 'sessionDashboardExtensions')
    this.owner = ctx
    ctx.effect(() => () => { this.active = false }, 'session-dashboard: public service epoch')
  }
  handshake(): DashboardHandshake {
    if (!this.active) fail('UNAVAILABLE', 'Dashboard extension service is unloaded', 'errors.unavailable')
    const yes = { available: true, reason: null }
    return handshakeSchema.parse({ apiVersion: DASHBOARD_API_VERSION, serviceId: this.dashboard.serviceId, scope: this.store.identity(), capabilities: {
      query: yes, events: yes,
      completionReplay: { available: true, reason: 'Only complete, verified durable sources are covered; historical or missing work is never automatically replayed.' },
      evidenceCheck: { available: true, reason: 'Readonly execution-evidence verification only; it neither runs repository code nor accepts result quality.' },
      nativeSidebarFilter: { available: false, reason: 'No public host membership-filter registration capability; the dashboard does not filter the native sidebar list.' },
      isolatedExecution: { available: false, reason: 'Idempotent admission, generation revocation and isolation are not verified; no Agent or command execution is authorized.' },
      externalDelivery: { available: false, reason: 'Only plugin-local durable notifications are available; no external delivery is authorized.' },
      projectWorkflow: yes, businessHistory: yes, sessionInspection: yes,
      // The backend cannot infer browser slot availability or browser verification
      // from a host version. The frontend advertises its actual optional entry.
      sidebarEntry: { available: false, reason: 'Sidebar row controls are an optional browser capability owned by the frontend; the backend cannot infer whether they are mounted.' },
    } })
  }
  private assertQuery(raw: PublicQuery): void {
    assertApiVersion(raw)
    const query = publicQuerySchema.parse(raw)
    const handshake = this.handshake()
    if (query.serviceId && query.serviceId !== handshake.serviceId) fail('UNAVAILABLE', 'Dashboard service instance changed; negotiate again', 'errors.serviceChanged')
  }
  async snapshot(raw: PublicQuery, fence: () => void): Promise<PublicSnapshot> {
    this.assertQuery(raw); fence()
    const value = await this.dashboard.extensionSnapshot(fence)
    this.assertQuery(raw); fence()
    const result = publicSnapshotSchema.parse({ handshake: this.handshake(), boardRevision: value.board.revision, highWatermark: value.highWatermark, retainedFrom: value.retainedFrom, cards: value.cards, projects: value.board.projects })
    this.assertQuery(raw); fence()
    return result
  }
  events(raw: EventQuery, fence: () => void): EventPage {
    assertApiVersion(raw)
    const query = eventQuerySchema.parse(raw)
    const publicQuery = { apiVersion: query.apiVersion, ...(query.serviceId ? { serviceId: query.serviceId } : {}) }
    this.assertQuery(publicQuery); fence()
    const { scope: _scope, ...page } = this.store.events(query.after, query.limit)
    const result = eventPageSchema.parse({ ...page, handshake: this.handshake() })
    this.assertQuery(publicQuery); fence()
    return result
  }
  connect(raw: PublicQuery): DashboardReadLease {
    // Must precede registration lookup so old binaries receive an explicit version
    // failure, not an empty board or a misleading three-state projection.
    this.assertQuery(raw)
    const caller = this.ctx
    if (caller.fiber === this.owner.fiber || caller.fiber.uid === null || !caller.fiber.runtime) fail('FORBIDDEN', 'A readonly lease requires an actual separately loaded plugin registration', 'errors.forbidden')
    const id = this.dashboard.serviceId
    const ownIdentity: unknown = Reflect.get(this, symbols.original) ?? this
    let closed = false
    const stops = new Set<() => void>()
    const check = () => {
      if (closed || !this.active || caller.fiber.uid === null || ![1, 2].includes(caller.fiber.state) || this.dashboard.serviceId !== id) fail('FORBIDDEN', 'Plugin registration or service epoch expired; reconnect explicitly', 'errors.serviceChanged')
      const current = caller.get('sessionDashboardExtensions')
      if (!current || (Reflect.get(current, symbols.original) ?? current) !== ownIdentity) fail('UNAVAILABLE', 'Extension service scope changed', 'errors.scopeChanged')
    }
    const close = () => { if (closed) return; closed = true; for (const stop of stops) stop(); stops.clear() }
    caller.effect(() => close, 'session-dashboard: trusted read lease')
    const query = { apiVersion: DASHBOARD_API_VERSION, serviceId: id }
    return Object.freeze({
      handshake: () => { check(); return this.handshake() },
      snapshot: () => { check(); return this.snapshot(query, check) },
      events: async (after: number, limit = 100) => { check(); return this.events({ ...query, after, limit }, check) },
      subscribe: (listener: () => void) => { check(); const stop = this.store.subscribe(() => { try { check(); listener() } catch { /* invalidated caller cannot receive advisory callbacks */ } }); stops.add(stop); return () => { stops.delete(stop); stop() } },
      close,
    })
  }
}
