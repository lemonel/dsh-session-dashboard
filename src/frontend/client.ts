import { z } from 'zod'
import { snapshotSchema, upgradeBoardPayload } from '../shared/model.js'
import type { Card, Preferences, Snapshot } from '../shared/model.js'
import { mutationSchema, navigationQuerySchema, navigationResultSchema } from '../shared/commands.js'
import type { CandidateQuery, Command, Mutation, InspectionQuery, HistoryQuery } from '../shared/commands.js'
import { handshakeSchema, type DashboardHandshake } from '../shared/extension.js'
import { defaultTranslator, type Translator, type TranslationKey } from './i18n.js'
import type { EditorState } from './editor.js'
import { browserRequestId } from './request-id.js'

/** RPC results are deliberately unknown until the exported shared schemas validate them. */
export interface DashboardApi {
  handshake?(): Promise<unknown>
  snapshot(): Promise<unknown>
  candidates(query: CandidateQuery): Promise<unknown>
  mutate(input: Mutation): Promise<unknown>
  inspectSession?(input: InspectionQuery): Promise<unknown>
  history?(input: HistoryQuery): Promise<unknown>
  transcript?(input: { sessionId: string }): Promise<unknown>
  navigation?(input: z.infer<typeof navigationQuerySchema>): Promise<unknown>
}
const envelopeSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.unknown() })])
export class RpcFailure extends Error {
  constructor(readonly code: string, message: string, readonly messageKey?: string, readonly params?: Record<string, unknown>) { super(message); this.name = 'RpcFailure' }
}
export function unwrapRemote(value: unknown): unknown {
  const result = envelopeSchema.safeParse(value)
  if (!result.success) throw new RpcFailure('INVALID_RESPONSE', '服务返回格式不正确，请刷新或重试同步。')
  if (result.data.ok) return result.data.value
  const error = result.data.error
  const info = z.object({ code: z.string(), message: z.string(), details: z.object({ reason: z.string().optional(), messageKey: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }).optional() }).safeParse(error)
  throw new RpcFailure(info.success ? info.data.details?.reason ?? info.data.code : 'REMOTE', info.success ? info.data.message : defaultTranslator('errorRemote'), info.success ? info.data.details?.messageKey : undefined, info.success ? info.data.details?.params : undefined)
}
export function parseSnapshot(value: unknown): Snapshot {
  const payload = unwrapRemote(value)
  // A Host that has not restarted yet still serves the v8 board: upgrade it here so
  // the page keeps loading instead of failing the whole snapshot on a version bump.
  const upgraded = typeof payload === 'object' && payload !== null && 'board' in payload
    ? { ...payload as Record<string, unknown>, board: upgradeBoardPayload((payload as { board: unknown }).board) }
    : payload
  const parsed = snapshotSchema.safeParse(upgraded)
  if (!parsed.success) throw new RpcFailure('INVALID_RESPONSE', '仪表板数据未通过校验；已保留本地草稿，请重试。')
  return parsed.data
}
const errorKeys: Record<string, TranslationKey> = { CONFLICT: 'errorConflict', REVIEW_STALE: 'errorStale', SERVICE_STALE: 'serviceChanged', FORBIDDEN: 'errorForbidden', UNAVAILABLE: 'errorUnavailable', NOT_FOUND: 'errorNotFound', STORAGE: 'errorStorage', INVALID: 'errorInvalid', IN_USE: 'errorInUse', CLOSED: 'errorClosed', SCOPE_CHANGED: 'errorScope', UNSUPPORTED_API: 'errorUnavailable', INVALID_RESPONSE: 'errorInvalidResponse' }
export function errorMessageKey(error: unknown): TranslationKey { return error instanceof RpcFailure ? errorKeys[error.code] ?? 'errorRemote' : 'errorRequest' }
export function errorMessage(error: unknown, t = defaultTranslator): string { return t(errorMessageKey(error)) }
export interface NoticeMessage { readonly key: TranslationKey; readonly params?: Record<string, unknown> }
export interface DashboardState {
  snapshot: Snapshot | null
  preferences: Preferences | null
  handshake: DashboardHandshake | null
  extensionError: string | null
  loading: boolean
  pending: number
  error: string | null
  transportError: string | null
  preferenceError: string | null
  notice: string | null
  noticeMessage: NoticeMessage | null
  serviceChanged: boolean
  locationSequence: number
}
type PreferenceEdit = (current: Preferences) => Preferences

/** One request lifecycle per panel. Writes are FIFO; reads cannot overwrite a newer write. */
export class DashboardClient {
  private state: DashboardState = { snapshot: null, preferences: null, handshake: null, extensionError: null, loading: true, pending: 0, error: null, transportError: null, preferenceError: null, notice: null, noticeMessage: null, serviceChanged: false, locationSequence: 0 }
  private readonly listeners = new Set<() => void>()
  private alive = false
  private lifetime = 0
  private generation = 0
  private boundScope: string | null = null
  private boundService: string | null = null
  private translator: Translator = defaultTranslator
  private scopeInvalid = false
  private read: Promise<void> | null = null
  private readLifetime = 0
  private readGeneration = 0
  private tail: Promise<void> = Promise.resolve()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private preferenceTimer: ReturnType<typeof setTimeout> | null = null
  private preferenceEdits: PreferenceEdit[] = []
  private preferenceFlight: Promise<boolean> | null = null
  /** Memory belongs to the registered panel, not a React mount: host navigation retains a draft. */
  viewDraft: EditorState | null = null
  detailRequest: { membershipId: string; sessionId: string; serviceId: string; minimumRevision: number } | null = null
  requestDetails(card: Card, serviceId: string, minimumRevision = 0): void { this.detailRequest = { membershipId: card.membershipId, sessionId: card.sessionId, serviceId, minimumRevision }; this.publish({ locationSequence: this.state.locationSequence + 1 }) }
  constructor(readonly api: DashboardApi, private readonly pollMs = 3000) {}
  setTranslator(t: Translator): void { this.translator = t }
  get serviceId(): string | null { return this.boundService }
  /** Adopt a mutation snapshot obtained through the membership channel instead of
   *  issuing another snapshot read. The service epoch must still match exactly. */
  acceptExternalSnapshot = (snapshot: Snapshot, serviceId: string): boolean => {
    if (!this.alive || this.state.serviceChanged || this.state.transportError) return false
    if (!this.state.handshake || this.state.handshake.serviceId !== serviceId) return false
    this.generation += 1
    this.accept(snapshot)
    return true
  }
  acknowledgeService = (): void => { this.boundService = this.state.handshake?.serviceId ?? null; this.publish({ serviceChanged: false, error: null }) }
  getSnapshot = (): DashboardState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<DashboardState>): void {
    if (!this.alive) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  /** Raw external diagnostics stay verbatim. Plugin-authored copy uses a key so
   * changing the host language re-renders the same notice, without replaying work. */
  notice = (notice: string | null): void => { this.publish({ notice, noticeMessage: null }) }
  noticeKey = (key: TranslationKey, params?: Record<string, unknown>): void => { this.publish({ notice: null, noticeMessage: { key, ...(params ? { params } : {}) } }) }
  dismissError = (): void => { this.publish({ error: null }) }
  private visibility = (): void => {
    if (document.visibilityState !== 'hidden') { void this.refresh(); this.schedulePoll() }
    else if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }
  start(): void {
    if (this.alive) return
    this.alive = true; this.lifetime++
    this.publish({ pending: 0 })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility)
    void this.refresh(); this.schedulePoll()
    if (this.preferenceEdits.length) this.schedulePreferences()
  }
  stop(): void {
    this.alive = false; this.lifetime++; this.generation++
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.preferenceTimer) clearTimeout(this.preferenceTimer)
    this.pollTimer = null; this.preferenceTimer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility)
  }
  private schedulePoll(): void {
    if (!this.alive || this.pollTimer || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      if (!this.alive) return
      void this.refresh().finally(() => this.schedulePoll())
    }, this.pollMs)
    // Browser pages and tests may leave the dashboard client running while the
    // panel is unmounted; a polling timer must not keep Node alive.
    if (typeof (this.pollTimer as { unref?: () => void }).unref === 'function') (this.pollTimer as { unref?: () => void }).unref?.()
  }
  private accept(snapshot: Snapshot): void {
    if (this.state.snapshot && snapshot.board.revision < this.state.snapshot.board.revision) return
    let preferences = snapshot.board.preferences
    if (this.preferenceFlight) preferences = this.state.preferences ?? preferences
    else for (const edit of this.preferenceEdits) preferences = edit(preferences)
    preferences = { ...preferences, revision: snapshot.board.preferences.revision }
    this.publish({ snapshot, preferences, loading: false, transportError: null })
  }
  refresh = async (): Promise<void> => {
    if (!this.alive) return
    if (this.read) {
      await this.read
      if (!this.alive || this.readLifetime === this.lifetime && this.readGeneration === this.generation) return
    }
    const lifetime = this.lifetime
    this.readLifetime = lifetime
    const generation = ++this.generation
    this.readGeneration = generation
    const request = (async () => {
      try {
        let handshake: DashboardHandshake | null = null
        let extensionError: string | null = null
        if (this.api.handshake) {
          try { handshake = handshakeSchema.parse(unwrapRemote(await this.api.handshake())) }
          catch (error) { extensionError = `增强服务不可用：${errorMessage(error)}` }
        } else extensionError = '当前后端未提供扩展协商，增强功能已关闭'
        const scopeKey = handshake ? JSON.stringify(handshake.scope) : null
        if (scopeKey && this.boundScope === null) this.boundScope = scopeKey
        if (scopeKey && this.boundScope !== scopeKey) this.scopeInvalid = true
        if (this.scopeInvalid) throw new RpcFailure('SCOPE_CHANGED', 'Scope changed')
        if (handshake && this.boundService === null) this.boundService = handshake.serviceId
        if (handshake && handshake.serviceId !== this.boundService && this.alive && lifetime === this.lifetime) this.publish({ serviceChanged: true })
        const snapshot = parseSnapshot(await this.api.snapshot())
        if (this.alive && lifetime === this.lifetime && generation === this.generation) this.publish({ handshake, extensionError })
        if (this.alive && lifetime === this.lifetime && generation === this.generation) this.accept(snapshot)
      } catch (error) {
        if (this.alive && lifetime === this.lifetime && generation === this.generation) this.publish({ loading: false, transportError: errorMessage(error, this.translator), handshake: null, extensionError: '连接失效，旧扩展动作已关闭' })
      }
    })()
    this.read = request
    await request
    if (this.read === request) this.read = null
  }
  private write(command: Command | (() => Command), preferences = false): Promise<Snapshot | null> {
    if (!this.alive) return Promise.resolve(null)
    const lifetime = this.lifetime
    const serviceId = this.boundService
    this.publish({ pending: this.state.pending + 1, ...(preferences ? {} : { error: null }) })
    const run = this.tail.then(async () => {
      if (!this.alive || lifetime !== this.lifetime) return null
      ++this.generation
      try {
        if (this.scopeInvalid) throw new RpcFailure('SCOPE_CHANGED', '数据范围已变化，旧编辑器不能提交；请重新载入页面，草稿可先复制保留。')
        if (!serviceId || this.state.serviceChanged || this.state.handshake?.serviceId !== serviceId) throw new RpcFailure('SERVICE_STALE', 'Service changed')
        const input = mutationSchema.parse({ apiVersion: 2, serviceId, requestId: browserRequestId(), command: typeof command === 'function' ? command() : command })
        const snapshot = parseSnapshot(await this.api.mutate(input))
        if (!this.alive || lifetime !== this.lifetime) return null
        ++this.generation // Supersede every snapshot read begun before this write settled.
        this.accept(snapshot)
        return snapshot
      } catch (error) {
        if (this.alive && lifetime === this.lifetime) this.publish(preferences ? { preferenceError: errorMessage(error, this.translator) } : { error: errorMessage(error, this.translator) })
        return null
      } finally {
        if (this.alive && lifetime === this.lifetime) this.publish({ pending: Math.max(0, this.state.pending - 1) })
      }
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
  mutate = async (command: Command): Promise<Snapshot | null> => {
    const snapshot = await this.write(command)
    if (!snapshot && this.alive) void this.refresh()
    return snapshot
  }
  navigation = async (sessionId: string, expectedLifecycleRevision?: number, runtimeFingerprint?: string): Promise<z.infer<typeof navigationResultSchema>> => {
    if (!this.api.navigation) throw new RpcFailure('UNAVAILABLE', '当前服务不支持可靠导航复核；未进入会话，请升级或重试同步。')
    const query = navigationQuerySchema.parse({ sessionId, ...(expectedLifecycleRevision === undefined ? {} : { expectedLifecycleRevision }), ...(runtimeFingerprint === undefined ? {} : { runtimeFingerprint }) })
    const result = navigationResultSchema.safeParse(unwrapRemote(await this.api.navigation(query)))
    if (!result.success || result.data.sessionId !== sessionId) throw new RpcFailure('INVALID_RESPONSE', '导航复核结果不正确，未离开仪表板。')
    return result.data
  }
  updatePreferences(edit: PreferenceEdit): void {
    if (!this.state.preferences) return
    this.preferenceEdits.push(edit)
    this.publish({ preferences: edit(this.state.preferences), preferenceError: null })
    this.schedulePreferences()
  }
  private schedulePreferences(): void {
    if (this.preferenceTimer) clearTimeout(this.preferenceTimer)
    this.preferenceTimer = setTimeout(() => { this.preferenceTimer = null; void this.flushPreferences() }, 450)
  }
  flushPreferences = async (): Promise<boolean> => {
    if (this.preferenceTimer) { clearTimeout(this.preferenceTimer); this.preferenceTimer = null }
    if (this.preferenceFlight) {
      const ok = await this.preferenceFlight
      return ok && this.preferenceEdits.length > 0 ? this.flushPreferences() : ok
    }
    if (!this.preferenceEdits.length) return true
    if (!this.alive || !this.state.snapshot) return false
    const edits = this.preferenceEdits.splice(0)
    const flight = (async () => {
      const result = await this.write(() => {
        const baseline = this.state.snapshot?.board.preferences
        if (!baseline) throw new Error('仪表板尚未加载，无法保存视图。')
        let next = baseline
        for (const edit of edits) next = edit(next)
        const { revision: _revision, ...value } = next
        return { type: 'preferences', expectedRevision: baseline.revision, value }
      }, true)
      if (!result) {
        this.preferenceEdits.unshift(...edits)
        if (this.alive) await this.refresh()
        return false
      }
      this.publish({ preferenceError: null })
      return true
    })()
    this.preferenceFlight = flight
    const ok = await flight
    if (this.preferenceFlight === flight) this.preferenceFlight = null
    if (this.alive && this.state.snapshot) {
      let preferences = this.state.snapshot.board.preferences
      for (const edit of this.preferenceEdits) preferences = edit(preferences)
      this.publish({ preferences })
      if (ok && this.preferenceEdits.length) this.schedulePreferences()
    }
    return ok
  }
}
