import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUPPORTED_DSH_VERSIONS, hostCapabilities } from '../lib/shared/compatibility.js'
import { assertCompatibleHost, installedHostCapabilities, isTimedQuestionSchema, questionProjection } from '../lib/backend/compat.js'
import { sdkVersion, assertLocalSdk } from './tools/sdk.mjs'

test('compatibility is an exact nine-release contract; unknown and final lookalikes are refused', () => {
  assert.equal(SUPPORTED_DSH_VERSIONS.length, 9)
  for (const version of SUPPORTED_DSH_VERSIONS) assert.equal(hostCapabilities(version).version, version)
  for (const version of ['0.2.0', '0.2.1', '0.2.1-alpha.5', '0.2.1-rc.4', '0.3.0', 'garbage', '']) assert.throws(() => hostCapabilities(version), /Unsupported DSH/)
  assert.equal(hostCapabilities('0.2.0-rc.1').timedQuestions, false)
  assert.equal(hostCapabilities('0.2.0-rc.2').timedQuestions, true)
  assert.equal(hostCapabilities('0.2.1-alpha.2').principalPeers, false)
  assert.equal(hostCapabilities('0.2.1-alpha.3').principalPeers, true)
})

test('resolved SDK and critical peer versions are coherent and local, never global fallback', async () => {
  await assertLocalSdk()
  assert.equal(assertCompatibleHost().version, sdkVersion)
  assert.deepEqual(installedHostCapabilities(), hostCapabilities(sdkVersion))
})

test('question compatibility exposes only actual host timed support and validates unknown projections', () => {
  const timed = { name: 'ask_user_question', parameters: { type: 'object', properties: { timeout: { type: 'number' } } } }
  assert.equal(isTimedQuestionSchema(timed), hostCapabilities(sdkVersion).timedQuestions)
  assert.equal(isTimedQuestionSchema(null), false)
  assert.equal(isTimedQuestionSchema({ name: 'other', parameters: {} }), false)
  const active = { active: [] }
  assert.equal(questionProjection(undefined), undefined)
  assert.equal(questionProjection({ values: {} }), undefined)
  assert.equal(questionProjection({ values: { userQuestions: active } }), active)
  assert.throws(() => questionProjection({ values: null }), /Invalid host projection/)
})

test('runtime guard refuses mixed or unsupported installed releases before touching domain state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-dashboard-version-guard-'))
  const backend = join(root, 'lib/backend'), shared = join(root, 'lib/shared')
  await mkdir(backend, { recursive: true }); await mkdir(shared, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  // Copy the actual compiled guard. Only its inert domain-error dependency is
  // supplied locally so this test does not import any real/global SDK package.
  await writeFile(join(backend, 'compat.js'), await readFile(new URL('../lib/backend/compat.js', import.meta.url), 'utf8'))
  await writeFile(join(shared, 'compatibility.js'), await readFile(new URL('../lib/shared/compatibility.js', import.meta.url), 'utf8'))
  await writeFile(join(shared, 'commands.js'), 'export function fail(){throw new Error("unauthorized") }')
  const cordis = join(root, 'node_modules/@deepseek-ai/cordis')
  await mkdir(cordis, { recursive: true })
  await writeFile(join(cordis, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', type: 'module', exports: './index.js' }))
  await writeFile(join(cordis, 'index.js'), 'export const symbols={original:Symbol.for("cordis.original")}')
  const names = ['dsh-agent', 'dsh-session', 'dsh-session-query', 'dsh-session-persistence', 'dsh-session-projection', 'dsh-user-questions', 'dsh-user-approval', 'dsh-goal', 'dsh-client-connection', 'dsh-typert-protocol']
  for (const name of names) {
    const directory = join(root, 'node_modules/@deepseek-ai', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.0-rc.2', type: 'module', exports: { '.': './index.js', './package.json': './package.json' } }))
    await writeFile(join(directory, 'index.js'), 'export const isTimedAskUserQuestionSchema=()=>true')
  }
  const guard = pathToFileURL(join(backend, 'compat.js')).href
  const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', `const {assertCompatibleHost}=await import(${JSON.stringify(guard)}); assertCompatibleHost()`], { cwd: root, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' })
  assert.equal(invoke().status, 0)
  const agentManifest = join(root, 'node_modules/@deepseek-ai/dsh-agent/package.json')
  const agent = JSON.parse(await readFile(agentManifest, 'utf8'))
  await writeFile(agentManifest, JSON.stringify({ ...agent, version: '0.3.0' }))
  let result = invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Unsupported DSH/)
  await writeFile(agentManifest, JSON.stringify(agent))
  const sessionManifest = join(root, 'node_modules/@deepseek-ai/dsh-session/package.json')
  const session = JSON.parse(await readFile(sessionManifest, 'utf8'))
  await writeFile(sessionManifest, JSON.stringify({ ...session, version: '0.2.1-rc.2' }))
  result = invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Mixed DSH dependency tree/)
  await writeFile(sessionManifest, JSON.stringify(session))
  await writeFile(join(root, 'node_modules/@deepseek-ai/dsh-user-questions/index.js'), 'export const isTimedAskUserQuestionSchema=null')
  result = invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /missing its declared timed-question capability/)
  // Preserve this small explicit fixture for inspection; no inferred deletion.
})
