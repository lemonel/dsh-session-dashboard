import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mutationSchema } from '../../lib/shared/commands.js'
import { createBrowserRuntime, createFixture, mutation, pickWorkspaceAndCreate, prepareNewSession, sessionObservation } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime({ secureContext: false }) })
after(async () => { await runtime?.close() })
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const cryptoCapabilities = page => page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues }))

test('real insecure HTTP Chrome: native randomUUID absent; project creation and Membership persist through Gateway/Service/SQLite', async t => {
  const h = await createFixture(t, runtime, 'request-id-insecure-context'), title = 'HTTP UUID regression session'
  h.host.set('http-session', sessionObservation(title, 'not_started'), false)
  await h.openDashboard()
  const { page } = h
  // No crypto overrides/init scripts: this is Chrome's actual HTTP capability set.
  assert.equal(new URL(page.url()).origin, 'http://dashboard.test')
  assert.deepEqual(await cryptoCapabilities(page), { secure: false, randomUUID: 'undefined', getRandomValues: 'function' })
  // Create the project through the real dialog so its request ID also comes from insecure HTTP Chrome.
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新建项目', exact: true })
  await create.getByLabel('项目名称', { exact: true }).fill('HTTP UUID project')
  await mutation(h, 'create_project', () => create.getByRole('button', { name: '创建项目', exact: true }).click())
  await create.waitFor({ state: 'hidden' })
  const project = h.board().projects.find(value => value.name === 'HTTP UUID project')
  // 项目总览 is the only view, so the created project card is the surface to check.
  await page.getByRole('article', { name: 'HTTP UUID project', exact: true }).waitFor()

  await prepareNewSession(page, { sessionId: 'http-session', workspaceId: 'http-workspace' })
  const projectCard = page.getByRole('article', { name: 'HTTP UUID project', exact: true })
  await projectCard.getByRole('button', { name: '项目操作：HTTP UUID project', exact: true }).click()
  await projectCard.getByRole('group', { name: '项目操作：HTTP UUID project', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
  const call = await pickWorkspaceAndCreate(h)
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'a determined project writes without a second confirmation')
  const input = mutationSchema.parse(call.args.mutation)
  const inspection = h.calls.filter(item => item.method === 'inspectSession' && item.result.ok).at(-1)
  assert.deepEqual(input.command.inspection, inspection.result.value.binding, 'The one-step fallback must preserve the captured inspection fence')
  assert.equal(h.card('http-session').projectId, project.id)
  assert.equal(h.card('http-session').runtime.phase, 'not_started'); assert.equal(h.card('http-session').decision, null)
  const writes = h.calls.filter(item => item.method === 'mutate')
  assert(writes.some(item => item.args.mutation.command.type === 'create_project'))
  assert(writes.some(item => item.args.mutation.command.type === 'add_card'))
  for (const item of writes) { assert.equal(item.result.ok, true); assert.match(mutationSchema.parse(item.args.mutation).requestId, uuidV4) }
  assert.equal(new Set(writes.map(item => item.args.mutation.requestId)).size, writes.length)
  assert.deepEqual(await cryptoCapabilities(page), { secure: false, randomUUID: 'undefined', getRandomValues: 'function' })
})
