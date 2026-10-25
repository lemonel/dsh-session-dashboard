import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { SessionDashboardRemote } from './backend/remote.js'
import { DashboardService } from './backend/service.js'
import { SqliteBoardStore } from './backend/store.js'
import { createDshHost } from './backend/dsh-host.js'
import { databasePath, dataDirectory, profileBinding, profileDirectory, type DashboardConfig } from './backend/config.js'
import { ExtensionRegistry } from './backend/extensions-store.js'
import { BUILTIN_EXTENSIONS } from './shared/extensions/index.js'
import { registerExtensionRoutes } from './backend/extensions-routes.js'
import { TYPERT } from './backend/typert.host.js'
import { DashboardExtensions } from './backend/extensions.js'
import { assertCompatibleHost } from './backend/compat.js'

export const name = 'session-dashboard'
export const inject = ['sessions', 'agents', 'sessionQuery', 'sessionPersistence', 'typert', 'connection']
export const Config = z.object({ dataDir: z.string().i18n({ en: 'Optional absolute directory; defaults to this profile’s data/session-dashboard.', zh: '可选绝对目录；默认使用当前 profile 的 data/session-dashboard，数据库仍绑定当前 profile。' }) })
export async function apply(ctx: Context, config: DashboardConfig = {}): Promise<void> {
  assertCompatibleHost() // Refuse unsupported/mixed SDKs before any database write or RPC registration.
  const logger = ctx.logger('session-dashboard')
  const profile = profileDirectory(ctx)
  const path = databasePath(config, profile)
  let store: SqliteBoardStore
  try { store = new SqliteBoardStore(path, profileBinding(profile)) } catch (error) {
    // Opening can migrate a v8/v9/v10 database. A refusal there is the reason the
    // whole plugin (and therefore every route) is missing, so log it before rethrowing.
    logger.error('看板数据库打开或升级失败：%s', path)
    logger.error(error)
    throw error
  }
  logger.info('看板数据库已就绪：%s（schema %d）', path, store.read().schemaVersion)
  ctx.effect(() => () => store.close(), 'session-dashboard: database')
  // Operator-dropped extensions: files under <data>/extensions, listed and served
  // by our own routes so the loader never depends on DSH's plugin system.
  const extensionsRegistry = new ExtensionRegistry(dataDirectory(config, profile), BUILTIN_EXTENSIONS.map(module => module.manifest.id))
  registerExtensionRoutes(ctx, extensionsRegistry)
  const host = createDshHost(ctx)
  ctx.effect(() => () => host.close(), 'session-dashboard: host observations')
  const dashboard = new DashboardService(store, host, error => logger.warn(error))
  ctx.effect(() => () => dashboard.close(), 'session-dashboard: lifecycle coordination')
  // Loader normally mounts ./typert. Explicit registration also supports direct Cordis
  // loading; do not register a second copy if the package was already discovered.
  if (!ctx.typert.getPackage(TYPERT.package, 'host')) ctx.effect(() => ctx.typert.register(TYPERT), 'session-dashboard: strict RPC contract')
  const extensions = new DashboardExtensions(ctx, store, dashboard)
  // The remote plugin receives assembled services, not a forged invocation.
  class AssembledDashboardRemote extends SessionDashboardRemote {
    constructor(remoteCtx: Context) { super(remoteCtx, dashboard, extensions) }
  }
  await ctx.plugin(AssembledDashboardRemote)
  try { await dashboard.snapshot() } catch (error) {
    // A failed first snapshot leaves every RPC registered but unusable; log the
    // reason before the plugin load is reported as failed.
    logger.error('看板首次快照失败')
    logger.error(error)
    throw error
  }
}
