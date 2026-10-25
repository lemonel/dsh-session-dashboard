import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { hostCapabilities } from '../../lib/shared/compatibility.js'

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent/package.json'))
export const sdkVersion = JSON.parse(await readFile(manifestPath, 'utf8')).version
export const capabilities = hostCapabilities(sdkVersion)
if (process.env.DSH_MATRIX_VERSION) assert.equal(sdkVersion, process.env.DSH_MATRIX_VERSION, 'matrix must not silently use another SDK')
export async function assertLocalSdk() {
  const localRoot = join(packageRoot, 'node_modules')
  // Resolve every imported dependency through this package. Explicit matrix trees
  // install their own peers, never inherit a different globally installed host.
  for (const name of ['dsh-agent', 'dsh-agent-loop', 'dsh-agent-loop-testkit', 'dsh-llm', 'dsh-session-persistence-jsonl', 'dsh-goal-round-driver', 'dsh-api-gateway', 'dsh-typert-protocol']) {
    const path = fileURLToPath(import.meta.resolve(`@deepseek-ai/${name}/package.json`))
    const local = relative(localRoot, path)
    assert(!local.startsWith(`..${sep}`) && !isAbsolute(local), `${name} must resolve from this plugin's node_modules, not ${dirname(path)}`)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, sdkVersion, `${name} must match the exact SDK release under test`)
  }
}

/** Test carrier only. The production plugin never mints an owner identity.
 * New SDKs use their actual Peer class; old SDKs accept their public operator
 * face. Both are fixed on one test Connection, and alien peers remain alien. */
export async function mountGatewayPrerequisites(ctx) {
  if (!capabilities.principalPeers) return
  const remoteAccess = await import('@deepseek-ai/dsh-api-remote-access')
  const fiber = ctx.plugin(remoteAccess.default, {})
  await fiber.await()
  assert(ctx.get('remoteAccess'), 'the actual newer SDK access policy must mount')
  return fiber
}
export function browserPeer(ctx, id = 'isolated-dashboard-browser') {
  const peer = capabilities.principalPeers
    ? new Connection.Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    : { id, ctx, async dispose() {} }
  const connection = capabilities.principalPeers ? { browserPeer: peer } : { operator: peer }
  ctx.reflect.provide('connection', connection)
  return { peer, connection, replacePeer(value) {
    if (capabilities.principalPeers) connection.browserPeer = value
    else connection.operator = value
  } }
}
