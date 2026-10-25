import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Card, Project, Snapshot } from '../shared/model.js'
import { EMPTY } from '../shared/model.js'
import { handshakeSchema } from '../shared/extension.js'
import { mutationSchema, sessionInspectionSchema, type Command, type SessionInspection, type StateTarget } from '../shared/commands.js'
import { Modal } from './Modal.js'
import { LocaleProvider, useTranslator, type TranslationKey, type Translator } from './i18n.js'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorMessage, errorMessageKey, parseSnapshot, RpcFailure, unwrapRemote, type DashboardApi, type DashboardClient } from './client.js'
import { bindingMatches, canChooseState, reviewBinding, targetFor, targetMatches, valueText } from './view-model.js'
import { dashboardCss } from './styles.js'
import type { ProjectDrag } from './project-drag.js'
import { browserRequestId } from './request-id.js'

export type MembershipJoinStatus = 'applied' | 'dialog' | 'same' | 'failed' | 'skipped'
export interface MembershipJoinResult { status: MembershipJoinStatus }
export interface MembershipOutcome { message: string | ((t: Translator) => string); locate: () => void; noticeKey?: TranslationKey }
export interface MembershipRequest { source: ProjectDrag; projectId?: string | null; inspected?: Inspected }
export interface Inspected { value: SessionInspection; serviceId: string; scope: string }
export interface MembershipOptions {
  api?: DashboardApi
  applied?: (snapshot: Snapshot, sessionId: string, serviceId: string) => MembershipOutcome | void
}
/** A registered singleton intent channel, never one client/poller per sidebar row. */
export class MembershipRuntime {
  private request: MembershipRequest | null = null
  private readonly listeners = new Set<() => void>()
  private closed = false
  open = (source: ProjectDrag, projectId?: string | null, inspected?: Inspected): void => { if (this.closed || this.request !== null) return; this.request = { source, ...(projectId === undefined ? {} : { projectId }), ...(inspected === undefined ? {} : { inspected }) }; this.emit() }
  close = (): void => { this.request = null; this.emit() }
  getSnapshot = (): MembershipRequest | null => this.request
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  dispose(): void { this.closed = true; this.request = null; this.listeners.clear() }
}

async function inspectRequest(api: DashboardApi, request: MembershipRequest): Promise<Inspected> {
  if (!api.inspectSession || !api.handshake) throw new RpcFailure('UNAVAILABLE', 'Session inspection unavailable')
  const before = handshakeSchema.parse(unwrapRemote(await api.handshake()))
  if (request.source.kind !== 'sidebar' && request.source.serviceId !== before.serviceId) throw new RpcFailure('SERVICE_STALE', 'Stale source service')
  const value = sessionInspectionSchema.parse(unwrapRemote(await api.inspectSession({ sessionId: request.source.sessionId })))
  const after = handshakeSchema.parse(unwrapRemote(await api.handshake()))
  if (before.serviceId !== after.serviceId || value.binding.serviceId !== before.serviceId || JSON.stringify(before.scope) !== JSON.stringify(after.scope)) throw new RpcFailure('SERVICE_STALE', 'Service changed')
  if (value.candidate.sessionId !== request.source.sessionId || value.candidate.tracked && value.candidate.tracked.sessionId !== request.source.sessionId) throw new RpcFailure('INVALID_RESPONSE', 'Inspection session identity mismatch')
  if (request.source.kind === 'tracked') {
    const source = request.source, current = value.candidate.tracked
    if (!current || current.membershipId !== source.membershipId || current.metadataRevision !== source.metadataRevision || !bindingMatches(current, source.binding)) throw new RpcFailure('REVIEW_STALE', 'Stale tracked source')
  }
  return { value, serviceId: before.serviceId, scope: JSON.stringify(before.scope) }
}

async function submitRequest(api: DashboardApi, inspection: Inspected, command: Command): Promise<Snapshot> {
  if (!api.handshake) throw new RpcFailure('UNAVAILABLE', 'Session inspection unavailable')
  const current = handshakeSchema.parse(unwrapRemote(await api.handshake()))
  if (current.serviceId !== inspection.serviceId || JSON.stringify(current.scope) !== inspection.scope) throw new RpcFailure('SERVICE_STALE', 'Service changed')
  const input = mutationSchema.parse({ apiVersion: 2, serviceId: inspection.serviceId, requestId: browserRequestId(), command })
  return parseSnapshot(await api.mutate(input))
}

/** Built-in execution keeps its run origin; only custom/unset placements need a new explicit state. */
function preserved(card: Card): boolean {
  // A never-executed blank has no state or run to protect, so moving it between
  // projects can stay a one-step preserve operation.
  const blank = card.runtime.sync === 'synced' && card.runtime.sourceLive && card.runtime.phase === 'not_started'
    && card.runtime.episodeId === null && card.runtime.episodeOrder === 0
  return card.placement.kind === 'builtin' && (blank || card.placement.status !== 'in_progress' || !canChooseState(card))
}
function addMembership(sessionId: string, project: string, inspection: SessionInspection['binding']): Command {
  return { type: 'add_card', sessionId, projectId: project === EMPTY ? null : project, inspection }
}
function moveMembership(card: Card, project: string, targetProject: Project | undefined, selection: { preserve: boolean; target: StateTarget | null }): Command {
  const destination: Extract<Command, { type: 'move_project' }>['destination'] = selection.preserve ? { kind: 'preserve' } : selection.target ? { kind: 'custom', target: selection.target } : { kind: 'unset' }
  return { type: 'move_project', ...reviewBinding(card), projectId: project === EMPTY ? null : project, expectedTargetProjectRevision: targetProject?.revision ?? null, destination }
}

/** With a determined target project, only a genuinely unresolved decision keeps the dialog. */
type MembershipPlan = { kind: 'same' } | { kind: 'dialog' } | { kind: 'apply'; command: Command }
function membershipPlan(value: SessionInspection, projectId: string | null): MembershipPlan {
  const board = value.snapshot.board, card = value.candidate.tracked, project = projectId ?? EMPTY
  const targetProject = board.projects.find(row => row.id === project)
  if (project !== EMPTY && !targetProject) return { kind: 'dialog' }
  if (value.candidate.hostArchive.state !== 'active') return { kind: 'dialog' }
  if (card) {
    if (card.archivedAt !== null) return { kind: 'dialog' }
    if ((card.projectId ?? EMPTY) === project) return { kind: 'same' }
    if (!preserved(card)) return { kind: 'dialog' }
    return { kind: 'apply', command: moveMembership(card, project, targetProject, { preserve: true, target: null }) }
  }
  return { kind: 'apply', command: addMembership(value.candidate.sessionId, project, value.binding) }
}

/** Flush this panel's own debounced writes BEFORE capturing membership absence.
 * A determined target applies in one step; only unresolved decisions open the dialog.
 * This never retries a mutation or replaces the immutable source intent. */
export function createMembershipRequests(client: Pick<DashboardClient, 'flushPreferences' | 'noticeKey'>, runtime: MembershipRuntime, options: MembershipOptions = {}): { requestJoin: (source: ProjectDrag, projectId?: string | null) => Promise<MembershipJoinResult>; dispose: () => void } {
  let active = true
  let opening = false
  return {
    async requestJoin(source, projectId): Promise<MembershipJoinResult> {
      if (!active || opening || runtime.getSnapshot() !== null) return { status: 'skipped' }
      opening = true
      try {
        const saved = await client.flushPreferences()
        if (!active) return { status: 'skipped' }
        if (!saved) { client.noticeKey('preferencesUnsaved'); return { status: 'skipped' } }
        if (projectId === undefined || !options.api) { runtime.open(source, projectId); return { status: 'dialog' } }
        const request: MembershipRequest = { source, projectId }
        let inspected: Inspected
        try { inspected = await inspectRequest(options.api, request) }
        catch {
          // The dialog owns the visible failure, its recheck and the preserved intent.
          if (active) runtime.open(source, projectId)
          return { status: 'dialog' }
        }
        if (!active) return { status: 'skipped' }
        const plan = membershipPlan(inspected.value, projectId)
        if (plan.kind === 'same') { client.noticeKey('alreadySameProject'); return { status: 'same' } }
        if (plan.kind === 'dialog') { runtime.open(source, projectId, inspected); return { status: 'dialog' } }
        try {
          const snapshot = await submitRequest(options.api, inspected, plan.command)
          if (!active) return { status: 'skipped' }
          const outcome = options.applied?.(snapshot, source.sessionId, inspected.serviceId)
          client.noticeKey(outcome?.noticeKey ?? 'membershipSuccess')
          return { status: 'applied' }
        } catch (error) { if (active) client.noticeKey(errorMessageKey(error)); return { status: 'failed' } }
      } catch (error) {
        if (active) client.noticeKey(errorMessageKey(error))
        return { status: 'failed' }
      } finally { opening = false }
    },
    dispose() { active = false },
  }
}

export function MembershipDialog({ api, request, onClose, onChanged }: { api: DashboardApi; request: MembershipRequest; onClose: () => void; onChanged: (snapshot: Snapshot, sessionId: string, serviceId: string) => MembershipOutcome | void }) {
  const t = useTranslator()
  const [inspection, setInspection] = useState<Inspected | null>(request.inspected ?? null)
  const [project, setProject] = useState(request.projectId === undefined ? '' : request.projectId ?? EMPTY)
  const [target, setTarget] = useState<StateTarget | null>(null)
  const [unset, setUnset] = useState(false)
  const [loading, setLoading] = useState(!request.inspected)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [hostConfirmed, setHostConfirmed] = useState(false)
  const [success, setSuccess] = useState(false)
  const [completion, setCompletion] = useState<MembershipOutcome | null>(null)
  const lifetime = useRef(0)
  const mounted = useRef(true)
  const sessionId = request.source.sessionId
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lifetime.current++ } }, [])
  const inspect = async () => {
    const ticket = ++lifetime.current
    setLoading(true); setFailure(null); setInspection(null); setHostConfirmed(false)
    try {
      const value = await inspectRequest(api, request)
      if (mounted.current && ticket === lifetime.current) setInspection(value)
    } catch (error) { if (mounted.current && ticket === lifetime.current) setFailure(errorMessage(error, t)) }
    finally { if (mounted.current && ticket === lifetime.current) setLoading(false) }
  }
  useEffect(() => { if (!request.inspected) void inspect() }, [sessionId])
  const board = inspection?.value.snapshot.board
  const card = inspection?.value.candidate.tracked
  const targetProject = board?.projects.find(row => row.id === project)
  const preserve = Boolean(card && preserved(card))
  const same = card ? (card.projectId ?? EMPTY) === project : false
  const archive = inspection?.value.candidate.hostArchive
  const invalidTarget = project !== EMPTY && !targetProject
  const targetValid = !target || Boolean(board && targetMatches(board, target))
  const selectionValid = !card || preserve || unset || Boolean(target && targetValid)
  const submit = async (restore = false) => {
    if (!inspection || !board || !project || busy || loading) return
    const ticket = lifetime.current
    setBusy(true); setFailure(null)
    try {
      if (!api.handshake) return
      if (!restore && archive?.state !== 'active' && archive?.state !== 'archived') { setFailure(t('hostUnknownJoin')); return }
      if (!restore && archive?.state === 'archived' && !hostConfirmed) return
      const command = restore && card ? { type: 'archive' as const, sessionId, membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision, archived: false, confirmedRunning: false }
        : card ? moveMembership(card, project, targetProject, { preserve, target }) : addMembership(sessionId, project, inspection.value.binding)
      const result = await submitRequest(api, inspection, command)
      if (!mounted.current || ticket !== lifetime.current) return
      setCompletion(onChanged(result, sessionId, inspection.serviceId) ?? null)
      setSuccess(true)
    } catch (error) { if (mounted.current && ticket === lifetime.current) setFailure(errorMessage(error, t)) }
    finally { if (mounted.current && ticket === lifetime.current) setBusy(false) }
  }
  return <Modal title={t('membershipTitle')} onClose={onClose} busy={busy}>
    <p>{t('membershipHint')}</p><h3>{inspection?.value.candidate.title || (request.source.kind === 'sidebar' ? request.source.displayTitle : '') || sessionId}</h3>
    {loading && <p role="status">{t('inspectLoading')}</p>}
    {failure && <div role="alert" className="sd-error"><p>{failure}</p><p>{t('inspectFailed')}</p><button disabled={busy || loading} onClick={() => { void inspect() }}>{t('recheck')}</button></div>}
    {inspection && board && !success && <>
      {card && <p>{t('currentProject', { name: valueText(board, 'project', card.projectId, t) })}</p>}
      <label className="sd-formfield"><span>{t('joinProject')}</span><select data-autofocus aria-label={t('joinProject')} value={project} disabled={busy} onChange={event => { setProject(event.target.value); setTarget(null); setUnset(false) }}><option value="" disabled>{t('chooseProject')}</option><option value={EMPTY}>{t('unassigned')}</option>{board.projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      {invalidTarget && <p role="alert">{t('projectMissing')}</p>}
      {card && !same && <><p>{t('moveQuestion', { title: card.titleOverride || card.hostTitle || sessionId, from: valueText(board, 'project', card.projectId, t), to: valueText(board, 'project', project, t) })}</p>{preserve ? <p className="sd-draftbar">{t('preserveOrigin')}</p> : <><p>{t('moveExplicitTarget')}</p><select aria-label={t('chooseTarget')} value={target?.statusId ?? (unset ? '__unset__' : '')} disabled={busy} onChange={event => { setUnset(event.target.value === '__unset__'); setTarget(board ? targetFor(board, event.target.value) : null) }}><option value="" disabled>{t('chooseTarget')}</option><option value="__unset__">{t('chooseUnset')}</option>{board?.statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></>}</>}
      {!targetValid && <p role="alert">{t('stateUnavailable')}</p>}
      {same && <p role="status">{t('alreadySameProject')}</p>}
      {card?.archivedAt !== null && card && <div className="sd-draftbar"><p>{t('restoreBeforeJoin')}</p><button disabled={busy} onClick={() => { void submit(true) }}>{t('restoreBoard')}</button></div>}
      {archive?.state === 'archived' && <label className="sd-check"><input type="checkbox" checked={hostConfirmed} onChange={event => setHostConfirmed(event.target.checked)} disabled={busy}/>{t('hostArchivedJoinConfirm')}</label>}
      {archive?.state !== 'active' && archive?.state !== 'archived' && <p role="alert">{t('hostUnknownJoin')}</p>}
    </>}
    {success && <div role="status"><p>{t('membershipSuccess')}</p>{completion && <><p>{typeof completion.message === 'function' ? completion.message(t) : completion.message}</p><button onClick={() => { completion.locate(); onClose() }}>{t('locateDetails')}</button></>}</div>}
    <div className="sd-modal-foot"><button disabled={busy} onClick={onClose}>{t(success ? 'closeDialog' : 'cancel')}</button>{!success && <button className="sd-primary" disabled={busy || loading || !inspection || !project || invalidTarget || same || Boolean(card?.archivedAt !== null && card) || !selectionValid || Boolean(failure) || archive?.state !== 'active' && !(archive?.state === 'archived' && hostConfirmed)} onClick={() => { void submit() }}>{t('confirmMembership')}</button>}</div>
  </Modal>
}

export function registerMembershipOverlay(ctx: Pick<Context, 'slots' | 'locale'>, api: DashboardApi, runtime: MembershipRuntime, translate: TranslateNS<'sessionDashboard'>, onChanged: (snapshot: Snapshot, sessionId: string, serviceId: string) => MembershipOutcome | void): void {
  function Overlay() {
    const request = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
    return request ? <LocaleProvider source={ctx.locale} t={translate}><section className="sd-root sd-overlay-root"><style>{dashboardCss}</style><MembershipDialog key={request.source.sessionId} api={api} request={request} onClose={runtime.close} onChanged={onChanged}/></section></LocaleProvider> : null
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-dashboard.membership', order: 450 }, () => createElement(Overlay)))
}
