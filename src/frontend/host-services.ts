import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** Structural faces for the optional client services the dashboard reads. The
 *  Host SDK types a browser Context as the server-side store, so each access goes
 *  through one checked boundary here instead of a cast at every call site. */
export interface SessionCatalogue {
  list: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { ids: readonly string[]; byId: Record<string, { retainedBy?: Record<string, number> } | undefined> }
  }
}
export interface WorkspaceItem { readonly workspaceId: string; readonly title: string; readonly path: string }
export interface WorkspaceFace {
  list?: { getSnapshot(): { readonly items: readonly WorkspaceItem[] } }
  create?: (input: { path: string }) => Promise<{ workspaceId: string; title: string; path: string }>
}
export interface LayoutFace { selectPanel(id: unknown): void }

/** `mainView` is the retention source the native page renders: whichever Session
 *  holds it is the one the page actually shows. */
export function shownSession(list: SessionCatalogue['list']): string | null {
  const state = list.getSnapshot()
  for (const id of state.ids) if ((state.byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
  return null
}

interface Scope { get(key: string): unknown }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

/** `get` throws for services the Host did not compose; absence is not an error. */
export function readService(scope: Scope, key: string): unknown {
  try { return scope.get(key) } catch { return undefined }
}

export function sessionCatalogue(scope: Scope): SessionCatalogue | undefined {
  const value = readService(scope, 'sessions')
  if (!isRecord(value) || !isRecord(value.list)) return undefined
  const list = value.list
  if (!isFunction(list.subscribe) || !isFunction(list.getSnapshot)) return undefined
  return value as unknown as SessionCatalogue
}

export function sessionController(scope: Scope): ISessions | undefined {
  const value = readService(scope, 'sessions')
  if (!isRecord(value)) return undefined
  // Fixtures and optional compositions expose only the operations they support.
  if (!isFunction(value.create) && !isFunction(value.using)) return undefined
  return value as unknown as ISessions
}

export function workspaceController(scope: Scope): WorkspaceFace | undefined {
  const value = readService(scope, 'workspaces')
  if (!isRecord(value)) return undefined
  const list = isRecord(value.list) && isFunction(value.list.getSnapshot) ? value.list as { getSnapshot(): { readonly items: readonly WorkspaceItem[] } } : undefined
  const create = isFunction(value.create)
    ? (input: { path: string }) => (value.create as (this: unknown, input: { path: string }) => Promise<{ workspaceId: string; title: string; path: string }>).call(value, input)
    : undefined
  return list || create ? { list, create } : undefined
}

export function layoutController(scope: Scope): LayoutFace | undefined {
  const value = readService(scope, 'layout')
  return isRecord(value) && isFunction(value.selectPanel) ? value as unknown as LayoutFace : undefined
}
