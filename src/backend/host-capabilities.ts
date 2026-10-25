import { symbols, type Context } from '@deepseek-ai/cordis'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { createHash, randomUUID } from 'node:crypto'
import type { HostArchive } from '../shared/model.js'
import { errorText } from '../shared/commands.js'

/** Cordis returns a new traceable proxy on each service read. Its public original
 * symbol identifies the actual provider without accessing reflect's private store. */
export function hostServiceIdentity(service: object): object {
  const original: unknown = Reflect.get(service, symbols.original)
  return original !== null && (typeof original === 'object' || typeof original === 'function') ? original : service
}

interface ArchiveSource {
  provider: object | null
  ids: readonly string[] | null
  signature: string
  unavailable: HostArchive | null
}
export interface ArchiveSnapshot {
  /** Includes provider incarnation, committed change hints and the complete set. */
  readonly generation: string
  readonly version: { sourceId: string; revision: number }
  fact(sessionId: string): HostArchive
  validate(): boolean
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Optional, read-only compatibility boundary. All eight supported SDKs publish
 * WorkspaceRegistry.archivedSessionIds and the workspace domain/changed contract.
 * No archive/restore method is called and no workspace domain is opened here. */
export class HostArchiveFacts {
  private closed = false
  private epoch = 0
  private readonly incarnation = randomUUID()
  private readonly providers = new WeakMap<object, number>()
  private nextProvider = 0
  private readonly watched = new Set<string>()
  private readonly stopDomain: () => void
  private readonly watcher: ReturnType<Context['inject']>

  constructor(private readonly ctx: Context, private readonly changed: (sessionId: string) => void) {
    this.stopDomain = ctx.on('domain/changed', change => {
      // The public workspaceDomainSpec.name is 'workspace' in the inspected eight
      // releases. Treat payloads only as invalidation hints, never archive truth.
      if (change.domain === 'workspace' && change.table === '' && change.key === '') this.invalidate()
    })
    this.watcher = ctx.inject(['workspaceRegistry'], () => {
      // Service activation/disposal changes strict ctx.get visibility only after
      // the inject callback returns. Deferred hints therefore read the new state.
      queueMicrotask(() => this.invalidate())
      return () => { queueMicrotask(() => this.invalidate()) }
    })
  }
  private invalidate(): void {
    if (this.closed) return
    this.epoch += 1
    for (const id of this.watched) this.changed(id)
  }
  private read(): ArchiveSource {
    let registry: WorkspaceRegistry | undefined
    let provider: object | null = null
    try {
      registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined) return { provider, ids: null, signature: 'unsupported', unavailable: { state: 'unsupported', reason: '当前宿主未提供公开的 workspaceRegistry 归档读取服务；不能推断为未归档' } }
      provider = hostServiceIdentity(registry)
      const value = registry.archivedSessionIds
      if (!Array.isArray(value)) return { provider, ids: null, signature: 'unsupported', unavailable: { state: 'unsupported', reason: '当前宿主没有公开的完整归档集合读取能力' } }
      if (value.some(id => typeof id !== 'string' || id.length === 0 || id.length > 240) || new Set(value).size !== value.length) throw new Error('宿主归档集合包含无效或重复身份')
      return { provider, ids: value, signature: hash(value), unavailable: null }
    } catch (error) {
      const reason = `无法可靠读取宿主归档事实：${errorText(error)}`.slice(0, 1000)
      return { provider, ids: null, signature: hash(reason), unavailable: { state: 'unknown', reason } }
    }
  }
  snapshot(): ArchiveSnapshot {
    const source = this.read()
    const epoch = this.epoch
    const ids = source.ids === null ? null : new Set(source.ids)
    let provider = 0
    if (source.provider !== null) {
      const known = this.providers.get(source.provider)
      provider = known ?? ++this.nextProvider
      if (known === undefined) this.providers.set(source.provider, provider)
    }
    return {
      generation: hash({ incarnation: this.incarnation, epoch, provider, signature: source.signature }),
      version: { sourceId: this.incarnation, revision: epoch },
      fact: sessionId => {
        if (sessionId.length !== 0) this.watched.add(sessionId)
        return source.unavailable === null ? { state: ids?.has(sessionId) ? 'archived' : 'active', reason: null } : { ...source.unavailable }
      },
      validate: () => {
        if (this.closed || this.epoch !== epoch) return false
        const current = this.read()
        // The official registry replaces its immutable archive array on every
        // archive/restore. Exact array identity catches archive→restore ABA even
        // before polling; the signature also detects an invalid in-place edit.
        return current.provider === source.provider && current.ids === source.ids && current.signature === source.signature
      },
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopDomain()
    this.watched.clear()
    void this.watcher.dispose().catch(() => { /* owning context also disposes its inject fiber */ })
  }
}
