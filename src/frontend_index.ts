import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { createElement } from 'react'
import { createPortal } from 'react-dom'
import remote from './shared/contract.js'
import { PANEL_ID } from './shared/model.js'
import type { Snapshot } from './shared/model.js'
import { DashboardClient } from './frontend/client.js'
import { dashboardChildren } from './frontend/contribution.js'
import type { DashboardSlots } from './shared/slots.js'
import { Dashboard, DashboardIcon } from './frontend/Dashboard.js'
import { LocaleProvider, type Translator } from './frontend/i18n.js'
import { dictionaries, LOCALE_NAMESPACE as NS } from './frontend/locales.js'
import { MembershipRuntime, createMembershipRequests, registerMembershipOverlay, type MembershipOutcome } from './frontend/Membership.js'
import { registerNativeSidebar } from './frontend/native-sidebar.js'
import { registerCompletionOverlay, watchCompletions } from './frontend/completions.js'
import { registerSidebarMembershipFilter } from './frontend/native-filter.js'
import { dashboardCss } from './frontend/styles.js'
import { resetPortalRenderer, setPortalRenderer } from './frontend/portal.js'
import { restorePanelOnBoot, watchPanelPreference, type PanelSelection } from './frontend/panel-restore.js'
import { mountPreviewFrame } from './frontend/preview-frame.js'
import { revealLinkedSession } from './frontend/session-open.js'
import { createHostAdapters } from './frontend/host-adapters.js'
import { layoutController, sessionController, workspaceController } from './frontend/host-services.js'
import { uninstallFacetClickSwallow } from './frontend/facets.js'
import { renameNativeTitle } from './frontend/session-rename.js'
import { createSessionInWorkspace } from './frontend/session-create.js'
import { promptNewSession } from './frontend/session-prompt.js'

// The status picker portals to document.body: project rows clip inline overlays.
// Installing the renderer here keeps react-dom out of every other frontend module.
setPortalRenderer(createPortal)

export const name = 'session-dashboard/client'
export const inject = ['slots', 'locale', 'remote', 'uiWorkspace']

/* Backend and frontend compile together. Cordis' globally merged `remote` can
 * select the Host face; the actual client runtime supplies TypertClientRemote.
 * This single official-interface adapter changes no services or fake Contexts. */
type FrontendContext = Pick<Context, 'slots' | 'locale' | 'uiWorkspace' | 'inject' | 'effect'> & { remote: TypertClientRemote }
export async function apply(context: Context): Promise<() => Promise<void>> {
  const ctx = context as FrontendContext
  const params = new URL(window.location.href).searchParams
  // A preview's enter link opens this URL in a new browser tab. That tab is a normal
  // plugin page (dashboard entry and panel included), so consume the parameter on
  // the regular path and additionally reveal the requested Session. A URL carrying
  // both markers still renders the complete native page instead of the frame branch.
  const openParam = params.get('session-dashboard-open')
  const openSource = openParam !== null && openParam !== '' ? openParam : null
  const previewSession = params.get('session-dashboard-preview')
  if (previewSession !== null && previewSession !== '') {
    const frame = await mountPreviewFrame(context, previewSession)
    return async () => { await frame.dispose() }
  }
  const unmount = await ctx.remote.$mount(remote)
  const registered = ctx.inject(['remote', 'remote.sessionDashboard'], child => {
    const remoteClient = child as FrontendContext
    const client = new DashboardClient(remoteClient.remote.sessionDashboard)
    const adapters = createHostAdapters(context, child)
    child.effect(() => child.locale.register(NS, dictionaries), 'session-dashboard:locale')
    const translate = child.locale.bind(NS)
    client.start()
    child.effect(() => {
      // The completion dot, toast and sidebar filter live outside .sd-root; their
      // styles must exist even when the dashboard panel has never been mounted.
      const style = document.createElement('style')
      style.dataset.sessionDashboardStyles = 'true'
      style.textContent = dashboardCss
      document.head.append(style)
      return () => style.remove()
    }, 'session-dashboard:styles')
    child.effect(() => () => client.stop(), 'session-dashboard:client-lifecycle')
    child.effect(() => watchCompletions(client), 'session-dashboard:completion-watch')
    child.effect(() => {
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return
        const data: unknown = event.data
        if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== 'session-dashboard-preview-change') return
        void client.refresh()
      }
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    }, 'session-dashboard:preview-change')
    const membership = new MembershipRuntime()
    const applied = (snapshot: Snapshot, sessionId: string, serviceId: string): MembershipOutcome | void => {
      const card = snapshot.board.cards.find(row => row.sessionId === sessionId)
      if (!card) return
      if (!client.acceptExternalSnapshot(snapshot, serviceId)) void client.refresh()
      return { message: (current: Translator) => current('joinedVisible'), noticeKey: 'joinedVisible', locate: () => {
        client.requestDetails(card, serviceId, snapshot.board.revision)
        layoutController(child)?.selectPanel(PANEL_ID as MainPanelId)
      } }
    }
    const membershipRequests = createMembershipRequests(client, membership, { api: remoteClient.remote.sessionDashboard, applied })
    registerMembershipOverlay(child, remoteClient.remote.sessionDashboard, membership, translate, applied)
    registerCompletionOverlay(child, translate, client)
    child.effect(() => registerSidebarMembershipFilter(client, translate), 'session-dashboard:sidebar-filter')
    registerNativeSidebar(child, { requestJoin: (sessionId, displayTitle) => { void membershipRequests.requestJoin({ kind: 'sidebar', sessionId, displayTitle }) }, t: translate })
    child.effect(() => () => { membershipRequests.dispose(); membership.dispose() }, 'session-dashboard:membership')
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: PANEL_ID, children: dashboardChildren }, (props: DashboardSlots) => createElement(LocaleProvider, { source: child.locale, t: translate, children: createElement(Dashboard, {
      client, renderSlot: props.renderSlot, requestJoin: membershipRequests.requestJoin,
      // The shared boundary validates nonempty durable IDs. Brand only at the
      // native navigation call; never invoke nonexistent workspace.selectSession.
      openSession: (id: string) => child.uiWorkspace.openSession(id as SessionId),
      // Forking never changes the current selection; a refusal is reported by the row.
      forkSession: async (id: string) => {
        try { return String(await child.uiWorkspace.forkSession(id as SessionId)) } catch { return null }
      },
      // The host face types Context.sessions as its store; the browser face is the
      // Client Session Controller. Look it up through one checked accessor.
      renameSession: (id: string, title: string) => {
        const sessions = sessionController(child)
        return sessions ? renameNativeTitle(sessions, id, title) : Promise.resolve({ ok: false as const, error: 'Session controller unavailable' })
      },
      // Creating a Session is a Client Session Controller operation, not a
      // dashboard RPC. The project does not own a Workspace, so the user picks
      // one from the Host's own list on every creation.
      listPresets: adapters.listPresets,
      loadModels: adapters.loadModels,
      listWorkspaces: async () => workspaceController(child)?.list?.getSnapshot().items.map(item => ({ workspaceId: item.workspaceId, title: item.title, path: item.path })) ?? [],
      createSession: async (workspaceId: string, options: { agentPreset?: string; model?: { provider: string; model: string; reasoningEffort?: string } } = {}) => {
        const sessions = sessionController(child)
        // A refusal must reach the toast with its reason; never fabricate an id.
        if (!sessions) throw new Error('Session controller unavailable')
        const session = adapters.sessionRemote()
        if (!session || !options.agentPreset && !options.model) return createSessionInWorkspace(sessions, workspaceId)
        const created = await session.create({ workspaceId, ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }) })
        if (!created.ok) throw new Error(created.error.message)
        const sessionId = String(created.value.sessionId)
        // Adopting the explicit id updates the Client catalogue without creating a
        // second Session; the Host create above is authoritative.
        try { await sessions.create({ workspaceId: workspaceId as WorkspaceId, sessionId: sessionId as SessionId }) } catch { /* catalogue event still arrives */ }
        if (options.model) {
          const selected = await session.selectModel({ sessionId, ...options.model })
          if (!selected.ok) client.noticeKey('newSessionModelApplyFailed', { reason: selected.error.message })
        }
        return sessionId
      },
      // Register a directory chosen in the host's own picker as a Workspace. The
      // Workspace projection is the authoritative id/title/path pair.
      createWorkspace: async (path: string) => {
        const workspaces = workspaceController(child)
        if (!workspaces?.create) throw new Error('Workspace controller unavailable')
        const workspace = await workspaces.create({ path })
        return { workspaceId: String(workspace.workspaceId), title: workspace.title, path: workspace.path }
      },
      pickDirectory: adapters.pickDirectory,
      // Optional first message, queued through the Client Session Controller.
      promptSession: (sessionId: string, text: string) => {
        const sessions = sessionController(child)
        return sessions ? promptNewSession(sessions, sessionId, text) : Promise.resolve({ ok: false as const, error: 'Session controller unavailable' })
      },
      // Host-owned New Session UI: its list lets the dashboard watch for the
      // first real message; the frame is the host's own root page.
      sessionList: sessionController(child)?.list,
      // Detection is subscription-driven: the Client Session Controller publishes
      // `api-session/added`/`removed`/`status`/`activity` into this same list, so
      // the overlay never re-reads the whole catalogue while it is open.
      creationFrameUrl: new URL('/', window.location.href).toString(),
    }) })))
    if (openSource !== null) revealLinkedSession(context, openSource)
    // The host restores the last conversation on boot, which can override this panel
    // after it was open when the page reloaded. Record the user's real choice and
    // re-apply only a remembered dashboard selection, for a short boot window. A
    // link-opened tab is a deliberate exception: its automatic Session reveal is not
    // the user's choice, so it skips both the dashboard restore and the preference
    // watcher and never clears the shared last-panel key.
    if (openSource === null) ctx.inject(['layout'], scope => {
      const layout = layoutController(scope)
      if (!layout) return
      scope.effect(() => {
        const stopRestore = restorePanelOnBoot(layout as PanelSelection, PANEL_ID as MainPanelId)
        const stopWatch = watchPanelPreference(layout as PanelSelection, PANEL_ID as MainPanelId)
        return () => { stopRestore(); stopWatch() }
      }, 'session-dashboard:panel-preference')
    })
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 4, label: () => translate('panel'), locale: NS }, DashboardIcon))
    child.effect(() => () => client.stop(), 'session-dashboard:client')
  })
  return async () => {
    await registered.dispose()
    await unmount()
    uninstallFacetClickSwallow(document)
    resetPortalRenderer()
  }
}
