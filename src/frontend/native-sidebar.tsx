import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties, DragEvent } from 'react'
import { useRef, useSyncExternalStore } from 'react'
import { z } from 'zod'

/** Plugin-owned transport, never the native sidebar's text/plain sorting data. */
export const NATIVE_SIDEBAR_DRAG_TYPE = 'application/x-session-dashboard-native-session'
const nativeSidebarDragSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1).max(240),
  displayTitle: z.string().max(1000),
}).strict()
export type NativeSidebarDrag = z.infer<typeof nativeSidebarDragSchema>
export type NativeSidebarTranslationKey = 'sidebarJoinProject' | 'sidebarDragHint'
export interface NativeSidebarActions {
  requestJoin: (sessionId: string, displayTitle: string) => void
  t: (key: NativeSidebarTranslationKey) => string
}

/** The identity is only a hint; the shared membership workflow rechecks authority. */
export function parseNativeSidebarDrag(text: string): NativeSidebarDrag | null {
  if (text.length > 8192) return null
  try {
    const input: unknown = JSON.parse(text)
    const parsed = nativeSidebarDragSchema.safeParse(input)
    return parsed.success ? parsed.data : null
  } catch { return null }
}

interface NativeSidebarInjected {
  requestJoin: NativeSidebarActions['requestJoin']
  translate: NativeSidebarActions['t']
  localeSubscribe: (listener: () => void) => () => void
  localeRevision: () => number
}
type RowProps = PropsRuntime<'sidebar.workspaces.session.row.action'> & InjectFace<NativeSidebarInjected>
const rowStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 2, border: 0, borderRadius: 4,
  background: 'transparent', color: 'inherit', cursor: 'grab', flex: 'none',
}
/** This child is the drag source: neither lifecycle event reaches SessionNodeItem. */
export function NativeSidebarRowAction({ sessionId, displayTitle, requestJoin, translate: t, localeSubscribe, localeRevision }: RowProps) {
  useSyncExternalStore(localeSubscribe, localeRevision, localeRevision)
  const dragged = useRef(false)
  const start = (event: DragEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    dragged.current = true
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(NATIVE_SIDEBAR_DRAG_TYPE, JSON.stringify({ version: 1, sessionId, displayTitle } satisfies NativeSidebarDrag))
    // Do not preventDefault: that would cancel the browser's actual drag.
  }
  return <button type="button" draggable data-sd-native-session={sessionId}
    aria-label={`${t('sidebarJoinProject')}: ${displayTitle || sessionId}`}
    title={t('sidebarDragHint')} style={rowStyle}
    onPointerDown={() => { dragged.current = false }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') dragged.current = false }}
    onDragStart={start}
    onDragEnd={event => { event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); if (!dragged.current) requestJoin(sessionId, displayTitle) }}>
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 20 20" fill="none">
      <path d="M2.5 5.5h5l1.5 2h8.5v9h-15z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M12.5 2v5M10 4.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  </button>
}

/** Declaration-aware registration also covers old/absent owners and their reloads.
 * No DOM lookup, native drag listener, poller, navigation, or backend request lives here.
 * The caller owns one membership dialog/runtime for clicks and project drops alike. */
export function registerNativeSidebar(ctx: Pick<Context, 'slots' | 'locale'>, actions: NativeSidebarActions): void {
  const inject = (): NativeSidebarInjected => ({
    requestJoin: actions.requestJoin, translate: actions.t,
    localeSubscribe: listener => ctx.locale.subscribe(listener),
    localeRevision: () => ctx.locale.getSnapshot().revision,
  })
  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action', id: 'session-dashboard.join-project', order: 300,
    inject,
  }, NativeSidebarRowAction))
}
