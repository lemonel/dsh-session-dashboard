import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { displayTitle } from '../shared/model.js'
import type { Card, Dimension, Entry, Preferences, Project } from '../shared/model.js'
import { DashboardClient } from './client.js'
import { completionCenter, previewCenter } from './completions.js'
import { ManageDialog } from './ManageDialog.js'
import { ExtensionsDialog } from './ExtensionsDialog.js'
import { ProjectOverview, ProjectDialog, type PendingProjectJoin } from './Projects.js'
import { Drawer } from './Drawer.js'

import { ConfirmDialog, Modal } from './Modal.js'
import { cardDraft, dirtyDraft, dirtyFields, editCommand, openEditor, type CardDraft, type EditorState } from './editor.js'
import { bindingMatches, entryCards, reviewBinding } from './view-model.js'
import { acceptState, chooseState } from './state-actions.js'
import { dashboardCss } from './styles.js'
import { PROJECT_DRAG_TYPE, type ProjectDrag } from './project-drag.js'
import type { DashboardCardOwner, DashboardSlotContext, DashboardSlots } from '../shared/slots.js'
import type { MembershipJoinResult } from './Membership.js'
import { publicHandshake, uiSummary } from './extension-view.js'
import { useTranslator } from './i18n.js'
import { EXTENSION_ENABLED_PATH } from '../shared/extensions/routes.js'
import { Popover } from './Popover.js'
import { WorkspacePickerDialog, type SessionCreateOptions, type SessionModelCatalog, type SessionPresetChoice, type WorkspaceChoice } from './WorkspacePicker.js'
import { OfficialCreateOverlay, type SessionListSource } from './OfficialCreate.js'
import { FacetStrip, SessionFacet } from './facets.js'
import { createCatalogSource } from './session-catalog.js'
import { availableFeatures, mountBuiltins, type HostSession } from '../shared/extensions/index.js'
import { importExtensions, mountImported, type ExtensionImport, type ExtensionLoad } from './extension-loader.js'
import type { SessionFacetDescriptor } from '../shared/facets.js'
import { failureReason } from './session-create.js'
import { OperationToasts, type OperationToastInput } from './Toasts.js'

interface Guard { proceed: () => void | Promise<void>; allowRetain?: boolean }
interface ProjectRemovalConfirmation { project: Project; serviceId: string }
const ERROR_NOTICE_KEYS = new Set<string>(['newSessionFailed', 'newSessionFailedReason', 'newSessionPromptFailed'])
export interface DashboardProps { client: DashboardClient; openSession: (sessionId: string) => void; renderSlot?: DashboardSlots['renderSlot']; requestJoin?: (source: ProjectDrag, projectId?: string | null) => MembershipJoinResult | void | Promise<MembershipJoinResult | void>; forkSession?: (sessionId: string) => Promise<string | null>; renameSession?: (sessionId: string, title: string) => Promise<{ ok: true; title: string } | { ok: false; error: string }>; /** Creates a blank Host Session in the chosen Workspace; null reports one failure and creates no membership. */ createSession?: (workspaceId: string, options?: SessionCreateOptions) => Promise<string | null>; /** Sends an optional first message through the Client Session Controller. */ promptSession?: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>; /** Workspaces the new Session can be created in, in Host order. */ listWorkspaces?: () => Promise<readonly WorkspaceChoice[]>; /** Agent presets offered by the Host's roster. */ listPresets?: () => Promise<readonly SessionPresetChoice[]>; /** Host-generation model catalog. */ loadModels?: () => Promise<SessionModelCatalog>; /** Register an absolute directory as a Workspace before creating there. */ createWorkspace?: (path: string) => Promise<WorkspaceChoice>; /** Host directory chooser; null means the operator cancelled. */ pickDirectory?: () => Promise<string | null>; /** Client Session Controller list; enables creation in the host's own UI. */ sessionList?: SessionListSource; /** Absolute URL of the host's New Session page for the embedded frame. */ creationFrameUrl?: string }
export function Dashboard({ client, openSession, renderSlot, requestJoin, forkSession, renameSession, createSession, promptSession, listWorkspaces, listPresets, loadModels, createWorkspace, pickDirectory, sessionList, creationFrameUrl }: DashboardProps) {
  const t = useTranslator()
  client.setTranslator(t)
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const [editor, setEditor] = useState<EditorState | null>(client.viewDraft), editorRef = useRef(editor)
  editorRef.current = editor
  const [creatingSession, setCreatingSession] = useState<string | null>(null), creating = useRef(false)
  const [workspaceDialog, setWorkspaceDialog] = useState<{ projectId: string; initialWorkspaceId: string | null } | null>(null), [lastWorkspaceId, setLastWorkspaceId] = useState<string | null>(null)
  const [officialCreate, setOfficialCreate] = useState<{ projectId: string } | null>(null)
  const [hiddenToasts, setHiddenToasts] = useState<Record<string, string>>({})
  const [managing, setManaging] = useState<Dimension | null>(null), [projectEditing, setProjectEditing] = useState<string | null | undefined>(undefined)
  const [guard, setGuard] = useState<Guard | null>(null)
  const [projectRemoval, setProjectRemoval] = useState<ProjectRemovalConfirmation | null>(null)
  const [pendingJoins, setPendingJoins] = useState<PendingProjectJoin[]>([])
  const joinSequence = useRef(0)
  const [guardBusy, setGuardBusy] = useState(false), [navigationGuard, setNavigationGuard] = useState(false)
  const managementReturn = useRef<{ x: number; y: number; trigger: HTMLButtonElement | null } | null>(null)
  const scroll = useRef<HTMLDivElement>(null), home = useRef<HTMLHeadingElement>(null), more = useRef<HTMLButtonElement>(null), navigating = useRef(false), mounted = useRef(true)
  const snapshot = state.snapshot, board = snapshot?.board, preferences = state.preferences
  // 项目总览 is the only view: an entry stored by the removed tabs or the removed
  // project board is read as the overview, so old boards load without a migration.
  const entry: Entry = 'projects'
  const busy = state.pending > 0 || guardBusy, ready = Boolean(snapshot && !state.transportError && !state.serviceChanged)
  const card = board?.cards.find(row => row.sessionId === editor?.draft.sessionId && row.membershipId === editor.draft.membershipId)
  const locationKey = preferences ? preferenceLocationKey(preferences) : 'projects'
  const updateEditor = (next: EditorState | null) => { editorRef.current = next; client.viewDraft = next; setEditor(next) }
  const newEditor = (current: Card) => ({ ...openEditor(current), serviceId: client.serviceId })
  // The card may move to another column once confirmed, so the details dialog is
  // told its origin id: closing it focuses the card wherever it now renders.
  useEffect(() => { mounted.current = true; completionCenter.markRead(); client.start(); return () => { mounted.current = false } }, [client])
  useEffect(() => { const warning = (event: BeforeUnloadEvent) => { if (editorRef.current && dirtyDraft(editorRef.current.draft)) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', warning); return () => window.removeEventListener('beforeunload', warning) }, [])
  useEffect(() => {
    const previous = editorRef.current
    if (!previous || !board) return
    const current = board.cards.find(row => row.sessionId === previous.draft.sessionId && row.membershipId === previous.draft.membershipId)
    if (!current || dirtyDraft(previous.draft)) return
    // A same-run sync moves lifecycle/workflow revisions without changing the run
    // the user opened. Rebinding it keeps the drawer usable; a genuinely new run
    // keeps the old binding so the explicit re-check remains required.
    const binding = previous.binding.episodeId === current.runtime.episodeId && !bindingMatches(current, previous.binding) ? reviewBinding(current) : previous.binding
    const draft = previous.draft.baseRevision !== current.metadataRevision ? cardDraft(current) : previous.draft
    if (binding !== previous.binding || draft !== previous.draft) updateEditor({ ...previous, binding, draft })
  }, [board])
  useLayoutEffect(() => { if (!scroll.current || !preferences) return; const position = preferences.locations[locationKey]; scroll.current.scrollLeft = position.x; scroll.current.scrollTop = position.y }, [Boolean(preferences), locationKey])
  useLayoutEffect(() => {
    const previous = managementReturn.current
    if (managing !== null || !previous || !scroll.current || !preferences) return
    managementReturn.current = null
    if (previous.trigger?.isConnected) previous.trigger.focus({ preventScroll: true })
    scroll.current.scrollLeft = previous.x
    scroll.current.scrollTop = previous.y
  }, [managing])
  const openManagement = (trigger?: HTMLButtonElement | null, dimension: Dimension = 'status') => {
    if (scroll.current) managementReturn.current = { x: scroll.current.scrollLeft, y: scroll.current.scrollTop, trigger: trigger ?? null }
    setManaging(dimension)
  }
  const recordLocation = () => { if (!scroll.current || !preferences) return; const x = Math.max(0, scroll.current.scrollLeft), y = Math.max(0, scroll.current.scrollTop); client.updatePreferences(current => ({ ...current, locations: { ...current.locations, [locationKey]: { x, y } } })) }
  const protect = (proceed: () => void | Promise<void>, allowRetain = false) => { if (editorRef.current && dirtyDraft(editorRef.current.draft)) setGuard({ proceed, allowRetain }); else void proceed() }
  /** Looking at the content is what moves a finished round from 待确认 to 待验收.
   *  The confirmation bumps the workflow revisions, so an editor already bound to
   *  the card is re-bound after it settles; otherwise its acceptance would read as
   *  stale even though this very window caused the transition. */
  const confirmReview = (next: Card) => {
    if (next.status !== 'pending_confirm') return Promise.resolve(false)
    // Confirming is the same execution run, so an editor already looking at it is
    // re-bound after the status transition. A genuinely newer run keeps the old
    // binding and still requires the explicit "I re-checked this round" step.
    return client.mutate({ type: 'confirm_review', ...reviewBinding(next) }).then(result => {
      if (!result) return false
      const current = result.board.cards.find(row => row.membershipId === next.membershipId)
      const previous = editorRef.current
      if (current && previous?.draft.membershipId === current.membershipId && previous.binding.episodeId === current.runtime.episodeId) updateEditor({ ...previous, binding: reviewBinding(current) })
      return true
    })
  }
  // A round that finishes while its details are open counts as looked at too.
  useEffect(() => {
    if (card && card.status === 'pending_confirm') void confirmReview(card)
  }, [card?.membershipId, card?.status, card?.runtime.episodeId])
  const openCard = (next: Card) => {
    const open = () => { if (editorRef.current?.draft.membershipId === next.membershipId) return; protect(() => { const current = client.getSnapshot().snapshot?.board.cards.find(row => row.membershipId === next.membershipId); if (current) updateEditor(newEditor(current)) }) }
    // Bind the details to the post-confirm revisions, so acceptance is armed immediately.
    if (next.status === 'pending_confirm') void confirmReview(next).finally(open)
    else open()
  }
  useEffect(() => {
    const request = client.detailRequest
    if (!request || !board || !state.handshake || state.serviceChanged) return
    if (board.revision < request.minimumRevision) return
    client.detailRequest = null
    const target = board.cards.find(row => row.membershipId === request.membershipId && row.sessionId === request.sessionId)
    if (target && request.serviceId === state.handshake.serviceId) openCard(target)
    else client.noticeKey('confirmStale')
  }, [state.locationSequence, board, state.handshake?.serviceId, state.serviceChanged])
  /** The host owns the session panel: a stale card must not surface as an
   *  uncaught error, so the entry point reports a failure like any other row action. */
  const enter = (sessionId: string): void => {
    try { openSession(sessionId) } catch { client.noticeKey('navigationError') }
  }
  const navigate = (sessionId: string, binding?: Card) => protect(async () => {
    if (binding) confirmReview(binding)
    if (navigating.current) return
    navigating.current = true; setGuardBusy(true)
    try {
      recordLocation()
      if (!await client.flushPreferences()) { client.noticeKey('preferenceBeforeLeave'); return }
      const result = await client.navigation(sessionId, binding?.lifecycleRevision, binding?.runtime.fingerprint)
      if (!mounted.current) return
      if (!result.allowed || result.hostArchive.state !== 'active') { setNavigationGuard(true); return }
      enter(sessionId)
    } catch {
      // A host that cannot answer the inspection RPC still lets the human in: the
      // native page is the authority on its own archive state, and refusing here
      // left the row with no way to enter the session at all.
      enter(sessionId)
    }
    finally { navigating.current = false; if (mounted.current) setGuardBusy(false) }
  }, true)
  const openPreview = (next: Card) => { confirmReview(next); previewCenter.open({ sessionId: next.sessionId, title: displayTitle(next), nativeTitle: next.hostTitle, episodeId: next.runtime.episodeId,
    // The window's status control reads the live board, so a change made here
    // updates it like a project row would, without freezing the open snapshot.
    state: {
      subscribe: listener => client.subscribe(listener),
      read: sessionId => {
        const board = client.getSnapshot().snapshot?.board ?? null
        return { board, card: board?.cards.find(row => row.sessionId === sessionId && row.archivedAt === null) ?? null }
      },
      onChangeState: (card, stateId) => changeProjectState(card, stateId),
      onReviewState: (card, stateId) => reviewProjectState(card, stateId),
    },
    onDetails: () => { previewCenter.close(); openCard(next) } }) }
  const saveDraft = async (): Promise<boolean> => {
    const previous = editorRef.current
    if (!previous) return true
    if (!dirtyFields(previous.draft)) return !dirtyDraft(previous.draft)
    if (previous.serviceId !== client.serviceId) { client.noticeKey('serviceChanged'); return false }
    const result = await client.mutate(editCommand(previous.draft))
    if (!result || !mounted.current) return false
    const saved = result.board.cards.find(row => row.membershipId === previous.draft.membershipId)
    if (!saved) return false
    const latest = editorRef.current
    if (latest?.draft.membershipId === saved.membershipId) updateEditor({ ...latest, draft: { ...cardDraft(saved), tagName: latest.draft.tagName } })
    client.noticeKey(latest?.draft.tagName ? 'savedPendingNotice' : 'savedNotice')
    return !latest?.draft.tagName
  }

  /** Row actions never grow the row: failures and fallbacks go to the toast stack. */
  const rowReport = (message: string) => { if (!client.getSnapshot().error) client.notice(message) }
  const rowTitle = async (current: Card, title: string): Promise<{ ok: boolean }> => {
    const value = title.trim()
    if (value.length > 160) { rowReport(t('rowTitleTooLong')); return { ok: false } }
    const displayed = (current.titleOverride ?? (current.hostTitle || current.sessionId)).trim()
    if (value === displayed) return { ok: true }
    // Clearing the box means "follow the native title again", never a rename.
    if (!value) {
      if (current.titleOverride === null) return { ok: true }
      const cleared = await client.mutate({ type: 'edit_card', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, tagIds: current.tagIds, titleOverride: null, progress: current.progress })
      if (!cleared) { rowReport(client.getSnapshot().error ?? t('rowTitleFailed')); return { ok: false } }
      client.noticeKey('rowTitleFollowHost')
      return { ok: true }
    }
    // Rename the native Session first so the host title changes for everyone.
    if (renameSession) {
      const renamed = await renameSession(current.sessionId, value)
      if (renamed.ok) {
        // Drop a stale dashboard-only override so the board shows the new host title.
        if (current.titleOverride !== null) void client.mutate({ type: 'edit_card', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, tagIds: current.tagIds, titleOverride: null, progress: current.progress })
        void client.refresh()
        client.noticeKey('rowTitleSaved')
        return { ok: true }
      }
      // The host refused: keep the dashboard usable with a title override and say so.
      const result = await client.mutate({ type: 'edit_card', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, tagIds: current.tagIds, titleOverride: value, progress: current.progress })
      if (!result) { rowReport(client.getSnapshot().error ?? renamed.error ?? t('rowTitleFailed')); return { ok: false } }
      client.noticeKey('rowTitleLocalOnly')
      return { ok: true }
    }
    const result = await client.mutate({ type: 'edit_card', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, tagIds: current.tagIds, titleOverride: value || null, progress: current.progress })
    if (!result) { rowReport(client.getSnapshot().error ?? t('rowTitleFailed')); return { ok: false } }
    client.noticeKey(renameSession ? 'rowTitleSaved' : 'rowTitleLocalOnly')
    return { ok: true }
  }
  const rowArchive = async (current: Card, archived: boolean): Promise<{ ok: boolean }> => {
    const result = await client.mutate({ type: 'archive', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, archived, confirmedRunning: archived })
    if (!result) { rowReport(client.getSnapshot().error ?? t('rowArchiveFailed')); return { ok: false } }
    client.noticeKey(archived ? 'archivedNotice' : 'restoredNotice')
    return { ok: true }
  }
  const rowFork = async (current: Card): Promise<{ ok: boolean }> => {
    if (!forkSession || !requestJoin) { rowReport(t('rowForkUnavailable')); return { ok: false } }
    let childId: string | null = null
    try { childId = await forkSession(current.sessionId) } catch { rowReport(t('rowForkFailed')); return { ok: false } }
    if (!childId) { rowReport(t('rowForkFailed')); return { ok: false } }
    const joined = await requestJoin({ kind: 'sidebar', sessionId: childId, displayTitle: `${displayTitle(current)} （fork）` }, current.projectId)
    if (joined && joined.status === 'failed') { rowReport(client.getSnapshot().error ?? t('rowForkFailed')); return { ok: false } }
    client.noticeKey('rowForked')
    return { ok: true }
  }
  const changeProjectState = async (current: Card, stateId: string | null) => {
    const saved = await chooseState(client, current, stateId)
    if (!saved || !mounted.current) return
    if (editorRef.current?.draft.membershipId === saved.membershipId) updateEditor(newEditor(saved))
  }
  const reviewProjectState = async (current: Card, stateId: string | null) => {
    await acceptState(client, current, stateId)
  }
  const rebaselineSource = async (current: Card) => {
    const result = await client.mutate({ type: 'rebaseline_source', sessionId: current.sessionId, membershipId: current.membershipId, expectedMetadataRevision: current.metadataRevision, confirmed: true })
    if (result && mounted.current) client.noticeKey('sourceRebaselined')
  }
  const reorderProjects = async (ids: string[]) => {
    const order = client.getSnapshot().snapshot?.board.orders.project
    if (!order || order.ids.length !== ids.length) return
    const result = await client.mutate({ type: 'reorder', dimension: 'project', ids, expectedRevision: order.revision })
    if (result && mounted.current) client.noticeKey('projectOrderSaved')
  }
  const confirmProjectRemoval = async () => {
    if (!projectRemoval || client.serviceId !== projectRemoval.serviceId) return
    const project = projectRemoval.project
    const result = await client.mutate({ type: 'delete_project', projectId: project.id, expectedProjectRevision: project.revision, confirmed: true })
    if (!result || !mounted.current) return
    setProjectRemoval(null)
    client.noticeKey('projectRemovedNotice')
  }
  const projectDrop = (source: ProjectDrag, targetProject?: string | null) => protect(async () => {
    if (!requestJoin || !ready) return
    const pending = source.kind === 'sidebar' && typeof targetProject === 'string'
      ? { token: `${source.sessionId}:${++joinSequence.current}`, sessionId: source.sessionId, projectId: targetProject, title: source.displayTitle || source.sessionId, phase: 'joining' as const }
      : null
    if (pending) setPendingJoins(current => current.some(item => item.sessionId === pending.sessionId && item.projectId === pending.projectId) ? current : [...current, pending])
    const confirm = async () => {
      if (!pending) return
      if (!mounted.current) return
      setPendingJoins(current => current.map(item => item.token === pending.token ? { ...item, phase: 'confirming' as const } : item))
      await client.refresh()
    }
    setGuardBusy(true)
    try {
      const result = await requestJoin(source, targetProject)
      if (pending && (result as MembershipJoinResult | void)?.status === 'failed') await confirm()
    } catch { await confirm() }
    finally {
      if (pending) setPendingJoins(current => current.filter(item => item.token !== pending.token))
      if (mounted.current) setGuardBusy(false)
    }
  })
  const rowActions = { onTitle: rowTitle, onArchive: rowArchive, onFork: rowFork, onDetails: openCard, onEnter: (current: Card) => navigate(current.sessionId, current), report: rowReport }
  // Only project rows can be dropped onto a project card, so only their action set carries the drag handle.
  const projectRowActions = { ...rowActions, ...(requestJoin && ready ? { onMoveDrag: (current: Card, event: DragEvent<HTMLButtonElement>) => {
    const serviceId = client.serviceId
    if (!serviceId || current.archivedAt !== null) { event.preventDefault(); return }
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, JSON.stringify({ kind: 'tracked', sessionId: current.sessionId, membershipId: current.membershipId, metadataRevision: current.metadataRevision, binding: reviewBinding(current), serviceId }))
    event.dataTransfer.effectAllowed = 'move'
  } } : {}) }
  const reloadDraft = () => { if (!card || !editor) return; protect(() => updateEditor(newEditor(card))) }
  // The overview is the only surface, so "visible" means every card it lists.
  /** Card-level slots the overview owns now that the column board is gone: a
   *  contribution renders inside the row, never as its own floating surface. */
  const rowExtensions = renderSlot ? { badge: (current: Card, occurrence: string) => renderSlot('session-dashboard.card.badge', ownerFor(current, occurrence)), menu: (current: Card, occurrence: string) => renderSlot('session-dashboard.card.menu.item', ownerFor(current, occurrence)) } : undefined
  const visibleCards = board ? entryCards(board, entry) : []
  const context: DashboardSlotContext = { handshake: state.transportError || state.serviceChanged ? null : publicHandshake(state.handshake), entry, projectId: null, uniqueVisible: visibleCards.length }
  const ownerFor = (current: Card, occurrenceId: string): DashboardCardOwner => {
    const epoch = context.handshake?.serviceId
    const request = async () => { const latest = client.getSnapshot(), row = latest.snapshot?.board.cards.find(item => item.membershipId === current.membershipId); if (!epoch || latest.transportError || latest.serviceChanged || latest.handshake?.serviceId !== epoch || !row) throw new Error('Stale dashboard contribution'); openCard(row) }
    const generation = snapshot?.memberGenerations?.find(row => row.membershipId === current.membershipId)?.cancellationGeneration ?? null
    return { context, card: uiSummary(board, current, generation), occurrenceId, actions: { openDetails: request, requestReview: request } }
  }
  const [extensionImport, setExtensionImport] = useState<ExtensionImport | null>(null)
  const [extensionRevision, setExtensionRevision] = useState(0)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [extensionBusy, setExtensionBusy] = useState(false)
  // One source object for every extension: the shipped set and the imported ones
  // get the same catalog handle, so a facet can never see a different board.
  const extensionSources = useMemo(() => ({
    translate: (key: string, params?: Record<string, unknown>) => t(key as Parameters<typeof t>[0], params),
    ...sessionList === undefined ? {} : { catalog: createCatalogSource(sessionList) },
    open: openSession,
  }), [t, sessionList, openSession])
  const extensionAvailable = useMemo(() => availableFeatures(extensionSources), [extensionSources])
  // The Host's list and modules are network work keyed by the revision alone: a
  // board update must not re-read the directory or re-import a module.
  useEffect(() => {
    const controller = new AbortController()
    void importExtensions(extensionRevision, { signal: controller.signal })
      .then(imported => { if (!controller.signal.aborted) setExtensionImport(imported) }, () => {})
    return () => controller.abort()
  }, [extensionRevision])
  // Mounting is a pure call over the imported modules and the current sources.
  const extensionMounted = useMemo(() => extensionImport === null ? null : mountImported(extensionImport.modules, extensionSources, extensionAvailable), [extensionImport, extensionSources, extensionAvailable])
  const extensionLoad: ExtensionLoad | null = useMemo(() => extensionImport === null || extensionMounted === null ? null : {
    ...extensionImport,
    mounted: extensionMounted.mounted,
    failures: [...extensionImport.failures, ...extensionMounted.failures],
    available: [...extensionAvailable],
  }, [extensionImport, extensionMounted, extensionAvailable])
  // Extensions are the only source of built-in facets: the dashboard mounts the
  // shipped set against the capabilities this instance can grant, and never
  // special-cases one. A mount failure stays reportable instead of blanking a row.
  // The Host's state file is the single source of truth for what is switched off,
  // built-ins included: one list, so a disabled built-in comes back the same way
  // an external one does. Until the first list arrives the shipped set mounts.
  const builtinDisabled = useMemo(() => new Set(extensionImport?.disabled ?? []), [extensionImport])
  const extensionSet = useMemo(() => mountBuiltins(extensionSources, builtinDisabled), [extensionSources, builtinDisabled])
  // One strip per row: the host's own facets first, then whatever plugins
  // registered. Both go through the same chip and panel, so a contribution can
  // never position itself against the row or open a second floating panel.
  const facets = (current: Card, occurrence: string): ReactNode => {
    const session: HostSession = { sessionId: current.sessionId, title: displayTitle(current), projectId: current.projectId, activeAgents: current.runtime.activeAgents ?? 0 }
    const builtin = [...extensionSet.mounted, ...extensionLoad?.mounted ?? []].flatMap(extension => extension.facets).flatMap(spec => {
      let chip
      // One misbehaving extension must not take the row down with it.
      try { chip = spec.chip(session) } catch { return [] }
      if (chip === null || chip === undefined) return []
      const facet: SessionFacetDescriptor = { id: spec.id, chip }
      const rows = spec.rows
      if (rows !== undefined) facet.detail = async () => ({ kind: 'rows' as const, rows: await rows(session), ...spec.empty === undefined ? {} : { empty: spec.empty } })
      return [<SessionFacet key={spec.id} facet={facet}/>]
    })
    const contributed = renderSlot?.('session-dashboard.card.facet', ownerFor(current, occurrence))
    // A registered slot with no contributions yields an empty array or an empty
    // string, not undefined: without this check every row would carry an empty
    // strip. Anything a contribution renders is a node, so these are the only
    // shapes that mean "nothing here".
    const registered = Array.isArray(contributed)
      ? contributed.length > 0
      : typeof contributed === 'string' ? contributed !== '' : contributed !== undefined && contributed !== null && contributed !== false
    if (builtin.length === 0 && !registered) return null
    return <FacetStrip label={t('sessionFacets')}>{builtin}{contributed}</FacetStrip>
  }
  /** Turn one extension on or off, then reload the set so the row reflects it. */
  const toggleExtension = async (id: string, enabled: boolean): Promise<void> => {
    setExtensionBusy(true)
    try {
      const response = await fetch(EXTENSION_ENABLED_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    } catch {
      // The list refresh below keeps the panel honest either way: a refused write
      // leaves the row exactly as the Host reports it.
    } finally {
      setExtensionBusy(false)
      setExtensionRevision(value => value + 1)
    }
  }
  /** Create, join, then optionally start the session with its first message.
   *  A send failure keeps the card: creation and membership already succeeded. */
  const createInWorkspace = async (projectId: string, workspaceId: string, initialPrompt = '', options: SessionCreateOptions = {}) => {
    if (creating.current || !createSession || !requestJoin) return
    creating.current = true; setCreatingSession(projectId)
    try {
      // Prefer an existing blank Session in this Workspace: DSH's own New Session
      // reuses one, and creating another would leave two blanks competing for that
      // reuse. A blank already tracked elsewhere is only announced, never moved
      // silently to the project the user just picked.
      let reuse: string | null = null, reused = false, move: { title: string; project: string } | null = null
      if (sessionList && listWorkspaces) {
        try {
          const workspace = (await listWorkspaces()).find(item => item.workspaceId === workspaceId)
          if (workspace) {
            const rows = sessionList.getSnapshot()
            for (const rawId of rows.ids) {
              const id = String(rawId), row = rows.byId[rawId] as { blank?: boolean; cwd?: string | null; origin?: string; parentId?: string } | undefined
              if (!row?.blank || row.cwd !== workspace.path || row.origin === 'subagent' || row.parentId) continue
              const existing = client.getSnapshot().snapshot?.board.cards.find(item => item.sessionId === id) ?? null
              if (existing && existing.projectId === projectId) { openPreview(existing); return }
              if (existing) {
                // A blank Session has no execution or state to protect. Reuse that
                // exact card and let the ordinary membership path move it here, so
                // the workspace keeps one blank instead of accumulating one per project.
                const board = client.getSnapshot().snapshot?.board
                const project = existing.projectId ? board?.projects.find(item => item.id === existing.projectId)?.name ?? t('unassigned') : t('unassigned')
                move = { title: displayTitle(existing), project }
                reuse = id
                break
              }
              reuse = id; reused = true
              break
            }
          }
        } catch { /* the normal create path still owns its own failure reporting */ }
      }
      const sessionId = reuse ?? await createSession(workspaceId, options)
      if (!sessionId) { if (mounted.current) client.noticeKey('newSessionFailed'); return }
      if (!mounted.current) return
      if (reused) client.noticeKey('workspaceBlankReused')
      const joined = await requestJoin({ kind: 'sidebar', sessionId, displayTitle: '' }, projectId)
      const joinedOk = Boolean(joined && joined.status === 'applied')
      if (joinedOk) {
        // Guide the user straight into the new Session in the same native iframe
        // preview used for existing cards. The card is already in the project, so
        // the first message typed in that frame belongs to this membership.
        const joinedCard = client.getSnapshot().snapshot?.board.cards.find(row => row.sessionId === sessionId)
        if (joinedCard) openPreview(joinedCard)
        else previewCenter.open({ sessionId, title: t('newSession'), episodeId: null })
      }
      const text = initialPrompt.trim()
      // Only start a Session that actually joined: otherwise the membership
      // dialog owns the failure and must not be overwritten by a started notice.
      if (text && joinedOk) {
        let sent: { ok: boolean; error?: string }
        try {
          sent = promptSession ? await promptSession(sessionId, text) : { ok: false, error: 'Session prompt unavailable' }
        } catch (error) { sent = { ok: false, error: failureReason(error) } }
        if (mounted.current) {
          if (sent.ok) client.noticeKey('newSessionStarted')
          else client.noticeKey('newSessionPromptFailed', { reason: sent.error ?? 'unknown' })
        }
        return
      }
      if (joinedOk && mounted.current) {
        if (move) client.noticeKey('workspaceBlankMove', move)
        else client.noticeKey('newSessionJoined')
      }
    } catch (error) { if (mounted.current) client.noticeKey('newSessionFailedReason', { reason: failureReason(error) }) }
    finally { creating.current = false; if (mounted.current) setCreatingSession(null) }
  }
  /** The only dashboard session-creation entry. Prefer the direct workspace
   *  picker (which can also register a new Workspace), create + join + open the
   *  native iframe; keep the official New Session overlay only as a fallback. */
  const newSession = (projectId: string) => {
    if (creating.current || !ready || !requestJoin) return
    // Only one native window is used at a time: creation takes over the preview's
    // floating window instead of leaving two native clients stacked on the page.
    previewCenter.close()
    if (createSession && listWorkspaces) { setWorkspaceDialog({ projectId, initialWorkspaceId: lastWorkspaceId }); return }
    if (sessionList && creationFrameUrl) { setOfficialCreate({ projectId }); return }
  }
  const noticeSignature = state.noticeMessage ? `${state.noticeMessage.key}:${JSON.stringify(state.noticeMessage.params ?? null)}` : state.notice ?? ''
  const noticeText = state.noticeMessage ? t(state.noticeMessage.key, state.noticeMessage.params) : state.notice
  const errorSignature = state.error ?? ''
  const transportSignature = state.transportError ?? (snapshot?.health.state === 'degraded' ? 'degraded' : '')
  const preferenceSignature = state.preferenceError ?? ''
  const joinsSignature = pendingJoins.map(join => join.token).join('|')
  const joinsText = pendingJoins.map(join => t(join.phase === 'confirming' ? 'confirmingJoinNamed' : 'joiningProjectNamed', { title: join.title })).join(' ')
  const presentToastKeys = [noticeSignature && 'notice', state.serviceChanged && 'serviceChanged', errorSignature && 'error', transportSignature && 'transport', preferenceSignature && 'preferences', joinsSignature && 'pendingJoins'].filter(Boolean).join('|')
  // Forgetting a locally dismissed key once its condition clears lets the same
  // failure show again later without resurrecting an old dismissal.
  useEffect(() => {
    const present = new Set(presentToastKeys.split('|').filter(Boolean))
    setHiddenToasts(current => {
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(next)) if (!present.has(key)) { delete next[key]; changed = true }
      return changed ? next : current
    })
  }, [presentToastKeys])
  const hideToast = (key: string, signature: string) => setHiddenToasts(current => ({ ...current, [key]: signature }))
  const operationToasts: OperationToastInput[] = []
  const pushToast = (toast: OperationToastInput) => { if (hiddenToasts[toast.key] !== toast.signature) operationToasts.push(toast) }
  if (noticeText) {
    const failed = state.noticeMessage ? ERROR_NOTICE_KEYS.has(state.noticeMessage.key) : false
    pushToast({ key: 'notice', signature: noticeSignature, tone: failed ? 'alert' : 'status', message: noticeText, auto: !failed, onDismiss: () => { client.notice(null); hideToast('notice', noticeSignature) } })
  }
  if (state.serviceChanged) pushToast({ key: 'serviceChanged', signature: 'serviceChanged', tone: 'alert', message: t('serviceChanged'), actions: [{ label: t('acknowledgeService'), onClick: client.acknowledgeService }], onDismiss: client.acknowledgeService })
  if (state.error) pushToast({ key: 'error', signature: errorSignature, tone: 'alert', message: `${state.error} ${t('failureRetained')}`, actions: [{ label: t('gotIt'), onClick: client.dismissError }], onDismiss: client.dismissError })
  if (transportSignature) pushToast({ key: 'transport', signature: transportSignature, tone: 'alert', message: state.transportError ?? t('syncProblem'), actions: [{ label: t('resync'), disabled: busy, onClick: () => { void client.refresh() } }], onDismiss: () => hideToast('transport', transportSignature) })
  if (state.preferenceError) pushToast({ key: 'preferences', signature: preferenceSignature, tone: 'alert', message: t('preferencesUnsaved'), actions: [{ label: t('retryPreferences'), disabled: busy, onClick: () => { void client.flushPreferences() } }], onDismiss: () => hideToast('preferences', preferenceSignature) })
  if (pendingJoins.length > 0) pushToast({ key: 'pendingJoins', signature: joinsSignature, tone: 'status', message: joinsText, onDismiss: () => hideToast('pendingJoins', joinsSignature) })

  return <section className="sd-root" aria-label={t('title')}><style>{dashboardCss}</style>
    <header className="sd-head">
      <div className="sd-titlebar">
        <div className="sd-titleblock">
          <span className="sd-eyebrow">{t('panel')}</span>
          <h1 tabIndex={-1} ref={home} data-sd-home>{t('title')}</h1>
          <p className="sd-subtitle">{t('subtitle')}</p>
        </div>
        <div className="sd-actions">
          <Popover label={t('moreActions')} closeOnSelect disabled={!board} buttonRef={more}>
            <button className="sd-menu-item" disabled={busy} onClick={() => { void client.refresh() }}>{t('refreshAll')}</button>
            <button className="sd-menu-item" onClick={() => openManagement(more.current)}>{t('manage')}</button>
            <button className="sd-menu-item" onClick={() => setExtensionsOpen(true)}>{t('extensionsManage')}</button>
            <button className="sd-menu-item" onClick={() => setExtensionRevision(value => value + 1)}>{t('reloadExtensions')}</button>
          </Popover>
        </div>
      </div>
    </header>

    {board && renderSlot && <div className="sd-toolbar"><div className="sd-toolbar-main">{renderSlot('session-dashboard.toolbar.action', { context })}</div></div>}{renderSlot?.('session-dashboard.summary.widget', { context })}
    <main className="sd-scroll" ref={scroll} onScroll={recordLocation}>
      {board && <p className="sd-summary">{t('globalHint')}</p>}
      {state.loading && <p role="status" className="sd-empty">{t('loadingDashboard')}</p>}{!state.loading && !board && <div className="sd-empty"><h2>{t('loadFailed')}</h2><p>{t('loadFailedHint')}</p><button onClick={() => { void client.refresh() }}>{t('retryLoad')}</button></div>}
      {board && entry === 'projects' && <ProjectOverview board={board} onOpenSession={openCard} onJoin={projectDrop} onCreate={() => setProjectEditing(null)} onNewSession={requestJoin && ((sessionList && creationFrameUrl) || (createSession && listWorkspaces)) ? newSession : undefined} newSessionBusy={creatingSession !== null} facets={current => facets(current, current.membershipId)} extensions={rowExtensions} onEdit={id => setProjectEditing(id)} onDelete={project => protect(() => { if (client.serviceId) setProjectRemoval({ project, serviceId: client.serviceId }) })} onReorder={ids => { void reorderProjects(ids) }} onPreviewSession={card => protect(() => openPreview(card))} onChangeState={(card, stateId) => changeProjectState(card, stateId)} onReviewState={(card, stateId) => reviewProjectState(card, stateId)} onManageTags={() => openManagement(more.current, 'tag')} rowActions={projectRowActions} pendingJoins={pendingJoins}/>}

    </main>
    {editor && card && board && <Drawer api={client.api} board={board} card={card} editor={editor} busy={busy} ready={ready && editor.serviceId === client.serviceId} extension={renderSlot?.('session-dashboard.detail.section', ownerFor(card, `detail:${card.membershipId}`))} onChange={(draft: CardDraft) => updateEditor({ ...editor, draft })} onClose={() => protect(() => updateEditor(null))} onSave={() => { void saveDraft() }} onReload={reloadDraft} onRebind={() => updateEditor({ ...editor, binding: reviewBinding(card), serviceId: client.serviceId })} onRebaselineSource={() => { void rebaselineSource(card) }} onResync={() => { void client.mutate({ type: 'resync', sessionId: card.sessionId }) }}/>}
    {editor && !card && board && <Modal title={t('missingCard')} onClose={() => protect(() => updateEditor(null))}><p>{t('missingCardHint')}</p><label>{t('localTitle')}<input readOnly value={editor.draft.titleOverride}/></label><label>{t('localProgress')}<textarea readOnly value={editor.draft.progress}/></label><label>{t('localTag')}<input readOnly value={editor.draft.tagName}/></label><button onClick={() => updateEditor(null)}>{t('discardLocal')}</button></Modal>}
    {extensionsOpen && <ExtensionsDialog load={extensionLoad} builtins={extensionSet} busy={extensionBusy} onToggle={(id, enabled) => { void toggleExtension(id, enabled) }} onReload={() => setExtensionRevision(value => value + 1)} onClose={() => setExtensionsOpen(false)}/>}{managing && board && <ManageDialog board={board} client={client} initialDimension={managing} busy={busy || !ready} onClose={() => setManaging(null)}/>}{projectEditing !== undefined && board && <ProjectDialog board={board} client={client} projectId={projectEditing} busy={busy || !ready} onClose={() => setProjectEditing(undefined)}/>}
    {projectRemoval && <ConfirmDialog title={t('deleteProjectTitle', { name: projectRemoval.project.name })} message={t('deleteProjectHint')} confirmText={t('confirmDeleteProject')} busy={busy} danger confirmDisabled={!ready || projectRemoval.serviceId !== state.handshake?.serviceId} onClose={() => setProjectRemoval(null)} onConfirm={() => { void confirmProjectRemoval() }}/>}
    {navigationGuard && <Modal title={t('navigationDenied')} onClose={() => setNavigationGuard(false)}><p>{t('hostArchiveGuide')}</p><p>{t('navigationContext')}</p><button onClick={() => setNavigationGuard(false)}>{t('backDashboard')}</button></Modal>}
    {officialCreate && board && requestJoin && sessionList && creationFrameUrl && <OfficialCreateOverlay projectId={officialCreate.projectId} board={board} frameUrl={creationFrameUrl} sessionList={sessionList} onClose={() => setOfficialCreate(null)} onJoin={(sessionId, displayTitle) => { const projectId = officialCreate.projectId; setOfficialCreate(null); void requestJoin({ kind: 'sidebar', sessionId, displayTitle }, projectId) }}/>}
    {workspaceDialog && listWorkspaces && <WorkspacePickerDialog initialWorkspaceId={workspaceDialog.initialWorkspaceId ?? lastWorkspaceId} list={listWorkspaces} busy={creatingSession !== null} promptEnabled={Boolean(promptSession)} listPresets={listPresets} loadModels={loadModels} onPickDirectory={pickDirectory} onCreateWorkspace={createWorkspace} onClose={() => setWorkspaceDialog(null)} onChoose={(workspaceId, prompt, options) => { const projectId = workspaceDialog.projectId; setLastWorkspaceId(workspaceId); setWorkspaceDialog(null); void createInWorkspace(projectId, workspaceId, prompt, options) }}/>}
    <OperationToasts toasts={operationToasts}/>
    {guard && <Modal title={t('unsavedTitle')} busy={busy} onClose={() => setGuard(null)}><p>{t('unsavedHint')}</p>{editor?.draft.tagName && <p>{t('pendingTagGuard')}</p>}{guard.allowRetain && <p>{t('retainDraftHint')}</p>}<div className="sd-modal-foot"><button disabled={busy} onClick={() => setGuard(null)}>{t('continueEditing')}</button><button disabled={busy} onClick={() => { const proceed = guard.proceed; if (card) updateEditor(newEditor(card)); else updateEditor(null); setGuard(null); void proceed() }}>{t('discardContinue')}</button>{guard.allowRetain && <button disabled={busy} onClick={() => { const proceed = guard.proceed; setGuard(null); void proceed() }}>{t('retainEnter')}</button>}<button className="sd-primary" disabled={busy || !card || Boolean(editor?.draft.tagName) || Boolean(editor && card.metadataRevision !== editor.draft.baseRevision)} onClick={() => { const proceed = guard.proceed; setGuardBusy(true); void saveDraft().then(async ok => { if (ok && mounted.current) { setGuard(null); await proceed() } }).finally(() => { if (mounted.current) setGuardBusy(false) }) }}>{t('saveContinue')}</button></div></Modal>}
  </section>
}
export function DashboardIcon({ size }: { size: number }) {
  const unread = useSyncExternalStore(completionCenter.subscribe, () => completionCenter.getSnapshot().unread, () => completionCenter.getSnapshot().unread)
  return <span className="sd-panel-icon" onClick={() => completionCenter.markRead()}><svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 3v18M15 3v18M3 9h6M9 14h6M15 11h6"/></svg>{unread && <i className="sd-panel-dot" aria-hidden="true"/>}</span>
}
export function preferenceLocationKey(_preferences: Preferences): keyof Preferences['locations'] { return 'projects' }
