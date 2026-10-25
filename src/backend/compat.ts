import { readFileSync } from 'node:fs'
import { symbols, type Context } from '@deepseek-ai/cordis'
import * as UserQuestions from '@deepseek-ai/dsh-user-questions'
import { hostCapabilities, type HostCapabilities } from '../shared/compatibility.js'
import { fail } from '../shared/commands.js'

const RUNTIME_PEERS = ['dsh-agent', 'dsh-session', 'dsh-session-query', 'dsh-session-persistence',
  'dsh-session-projection', 'dsh-user-questions', 'dsh-user-approval', 'dsh-goal',
  'dsh-client-connection', 'dsh-typert-protocol'] as const
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function installedVersion(name: string): string {
  // This module resolves only its declared peers. Never look in a global SDK,
  // cwd or a neighbouring checkout when a dependency is missing.
  const value: unknown = JSON.parse(readFileSync(new URL(import.meta.resolve(`@deepseek-ai/${name}/package.json`)), 'utf8'))
  if (!record(value) || typeof value.version !== 'string') throw new Error(`Invalid installed host manifest: ${name}`)
  return value.version
}
export function installedHostCapabilities(): HostCapabilities { return hostCapabilities(installedVersion('dsh-agent')) }
export function assertCompatibleHost(): HostCapabilities {
  const capabilities = installedHostCapabilities()
  for (const name of RUNTIME_PEERS) {
    const version = installedVersion(name)
    if (version !== capabilities.version) throw new Error(`Mixed DSH dependency tree: ${name}@${version}, expected ${capabilities.version}`)
  }
  if (capabilities.timedQuestions && (!('isTimedAskUserQuestionSchema' in UserQuestions) || typeof UserQuestions.isTimedAskUserQuestionSchema !== 'function')) throw new Error('Host is missing its declared timed-question capability')
  return capabilities
}

/** rc.1 has only the synchronous question waterfall. Newer releases own the
 * timed schema and projection; absence on rc.1 must not be emulated by a fake
 * continuation or by importing a symbol that does not exist in that release. */
export function isTimedQuestionSchema(value: unknown): boolean {
  if (!('isTimedAskUserQuestionSchema' in UserQuestions)) return false
  const check = UserQuestions.isTimedAskUserQuestionSchema
  if (typeof check !== 'function') throw new Error('Invalid host timed-question schema capability')
  if (!record(value) || typeof value.name !== 'string' || !record(value.parameters)) return false
  return check({ name: value.name, parameters: value.parameters }) === true
}
export function questionProjection(projection: unknown): unknown {
  if (projection === undefined) return undefined
  if (!record(projection) || !record(projection.values)) throw new Error('Invalid host projection snapshot')
  return projection.values.userQuestions
}

/** Keep the original browser-operator boundary across the principal migration.
 * New hosts may also admit API/remote peers: a caller merely claiming owner is
 * not the exact authenticated browser peer this plugin grants board access to.
 * Invocation, connection identity and abort state are rechecked before COMMIT. */
export function browserAuthorizationFence(ctx: Context): () => void {
  const invocation = ctx.invocation
  const connection: unknown = ctx.get('connection')
  // Cordis creates a new traceable proxy for each read; compare the Service, not its wrapper.
  const connectionIdentity: unknown = record(connection) ? Reflect.get(connection, symbols.original) ?? connection : undefined
  const capabilities = installedHostCapabilities()
  const peer: unknown = invocation?.peer
  const check = () => {
    const currentConnection: unknown = ctx.get('connection')
    if (!invocation || invocation.signal.aborted || !record(currentConnection) || !record(peer)
        || (Reflect.get(currentConnection, symbols.original) ?? currentConnection) !== connectionIdentity) {
      fail('FORBIDDEN', '仅宿主已认证的操作用户可以访问会话仪表板')
    }
    if (!capabilities.principalPeers) {
      if (currentConnection.operator !== peer) fail('FORBIDDEN', '仅宿主已认证的操作用户可以访问会话仪表板')
    } else {
      if (currentConnection.browserPeer !== peer || !record(peer.principal) || peer.principal.kind !== 'owner'
          || !(peer.signal instanceof AbortSignal) || peer.signal.aborted) {
        fail('FORBIDDEN', '仅宿主已认证且仍有效的浏览器所有者可以访问会话仪表板')
      }
    }
  }
  check(); return check
}
