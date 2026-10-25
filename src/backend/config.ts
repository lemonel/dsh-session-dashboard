import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { fail } from '../shared/commands.js'
export interface DashboardConfig { dataDir?: string }
function absoluteProfileDirectory(value: string | undefined): string {
  if (!value?.trim() || !isAbsolute(value)) fail('INVALID', '无法确定当前 profile 的绝对目录；请通过 DSH 启动，直接加载 Cordis 时须设置绝对 DSH_PROFILE_DIR')
  return resolve(value)
}
/** DSH exposes the active profile on Context, not necessarily in process.env. */
export function profileDirectory(ctx: Context, env: NodeJS.ProcessEnv = process.env): string {
  const profile: ProfileContext | undefined = ctx.get('profileContext')
  if (profile !== undefined) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || typeof profile.dir !== 'string') fail('INVALID', '宿主提供的 profileContext.dir 必须是绝对目录')
    return absoluteProfileDirectory(profile.dir)
  }
  // Compatibility for explicit, directly composed Cordis runtimes only.
  return absoluteProfileDirectory(env.DSH_PROFILE_DIR)
}
/** Preserve the existing realpath + SHA-256 database ownership identity. */
export function profileBinding(profile: string): string {
  let absolute = absoluteProfileDirectory(profile)
  try { absolute = realpathSync(absolute) } catch { /* the absolute configured profile remains explicit */ }
  return createHash('sha256').update(absolute).digest('hex')
}
/** Profile-scoped by default. Never fall back to cwd: one user may run several profiles. */
export function databasePath(config: DashboardConfig, profile: string): string {
  const absolute = absoluteProfileDirectory(profile)
  if (config.dataDir !== undefined) {
    if (!config.dataDir.trim() || !isAbsolute(config.dataDir)) fail('INVALID', 'dataDir 必须是明确的绝对路径')
    return join(resolve(config.dataDir), 'dashboard.sqlite')
  }
  return join(absolute, 'data', 'session-dashboard', 'dashboard.sqlite')
}

/** Directory that holds every profile-scoped artifact of this plugin. */
export function dataDirectory(config: DashboardConfig, profile: string): string {
  return dirname(databasePath(config, profile))
}
