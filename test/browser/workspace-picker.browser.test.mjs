import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { closePreview, createBrowserRuntime, createFixture, pickWorkspaceAndCreate, prepareNewSession, sessionObservation } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

test('New session picks a workspace, creates there and joins the acting project', async t => {
  const h = await createFixture(t, runtime, 'workspace-picker')
  h.host.set('picked', sessionObservation('Picked session', 'not_started'), false)
  await h.mutate({ type: 'create_project', name: 'Picker project', color: null, tagIds: [] })
  const project = h.board().projects.find(value => value.name === 'Picker project')
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await prepareNewSession(page, { sessionId: 'picked', workspaceId: 'ws-picked', title: 'Picked workspace', path: '/srv/picked' })
  const card = page.getByRole('article', { name: 'Picker project', exact: true })
  const openPicker = async () => {
    await card.getByRole('button', { name: '项目操作：Picker project', exact: true }).click()
    await card.getByRole('group', { name: '项目操作：Picker project', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
    await dialog.waitFor()
    return dialog
  }
  const dialog = await openPicker()
  await dialog.getByRole('radio', { name: 'Picked workspace', exact: true }).waitFor()
  await dialog.getByText('/srv/picked', { exact: true }).waitFor()
  await dialog.getByRole('radio', { name: 'Picked workspace', exact: true }).check()
  const call = await pickWorkspaceAndCreate(h, { title: 'Picked workspace' })
  assert.equal(call.result.ok, true)
  await page.getByText('新会话已创建并加入项目。', { exact: true }).waitFor()
  await page.locator('[data-card-id="picked"]').waitFor()
  assert.equal(h.card('picked').projectId, project.id)
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.createdWith), { workspaceId: 'ws-picked' }, 'creation targets the picked workspace')
  assert.equal(await page.evaluate(() => window.dashboardFixture.prompted), null, 'an empty message never prompts the session')
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.openSessionCalls), [], 'the created session is never opened')
  const createdPreview = page.getByRole('dialog', { name: '预览会话', exact: true })
  await createdPreview.waitFor()
  assert.match(await createdPreview.locator('iframe').getAttribute('src') ?? '', /session-dashboard-preview=picked/)
  await closePreview(page)

  const before = h.calls.filter(item => item.method === 'mutate' && item.args.mutation.command.type === 'add_card').length
  const cancelled = await openPicker()
  await cancelled.getByRole('button', { name: '取消', exact: true }).click()
  await cancelled.waitFor({ state: 'detached' })
  assert.equal(h.calls.filter(item => item.method === 'mutate' && item.args.mutation.command.type === 'add_card').length, before, 'cancelling never joins anything')
})

test('Enter does not create; a typed first message is sent after join', async t => {
  const h = await createFixture(t, runtime, 'workspace-picker-prompt')
  h.host.set('prompted-session', sessionObservation('Prompted session', 'not_started'), false)
  await h.mutate({ type: 'create_project', name: 'Prompt project', color: null, tagIds: [] })
  const project = h.board().projects.find(value => value.name === 'Prompt project')
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await prepareNewSession(page, { sessionId: 'prompted-session', workspaceId: 'ws-prompt', title: 'Prompt workspace', path: '/srv/prompt' })
  const card = page.getByRole('article', { name: 'Prompt project', exact: true })
  await card.getByRole('button', { name: '项目操作：Prompt project', exact: true }).click()
  await card.getByRole('group', { name: '项目操作：Prompt project', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('radio', { name: 'Prompt workspace', exact: true }).check()
  await dialog.getByRole('radiogroup', { name: '选择工作区', exact: true }).focus()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '启动内容（可选）', 'Enter moves into the message instead of submitting')
  assert.equal(await page.evaluate(() => window.dashboardFixture.createdWith), null, 'Enter from the workspace list never creates')
  assert.equal(await page.evaluate(() => window.dashboardFixture.prompted), null)
  await dialog.getByLabel('启动内容（可选）', { exact: true }).fill('开始执行')
  const call = await pickWorkspaceAndCreate(h, { prompt: '开始执行' })
  assert.equal(call.result.ok, true)
  await page.getByText('新会话已创建、加入项目并开始执行。', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.prompted), { sessionId: 'prompted-session', source: 'sessionDashboardCreate', content: [{ type: 'text', text: '开始执行' }], mode: 'queue' })
  await page.locator('[data-card-id="prompted-session"]').waitFor()
  assert.equal(h.card('prompted-session').projectId, project.id)
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.openSessionCalls), [])
})
