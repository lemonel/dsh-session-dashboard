import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { replayFixture } from '../helpers.mjs'

// Deliberately synthetic source evidence at the isolated UI/RPC boundary.
// Real AgentLoop, Goal and JSONL source authority have separate integration tests.
function setSource(h, id, value) {
  h.host.set(id, value, false)
  h.host.setSource(id, replayFixture(id, value.runtime))
}
import { closePreview, createBrowserRuntime, createFixture, expectCardStatus, openStatePanel, projectDropNative, sessionObservation, refresh, mutation, openProjectDrop, pickWorkspaceAndCreate, prepareNewSession, confirmReviewCard } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { await runtime?.close() })

test('one-step membership reports a saved visible session through a localized notice without changing preferences', async t => {
  const { h, project } = await setup(t, 'workflow-visible-location')
  setSource(h, 'hidden', sessionObservation('Hidden fresh session', 'not_started'))
  // The native sidebar drag (kept by design) is the remaining path that can join
  // an existing session into a project without creating anything.
  const before = structuredClone(h.board().preferences)
  const { page } = h
  await page.goto('http://dashboard.test')
  await page.waitForFunction(() => Boolean(window.dashboardFixture))
  await page.locator('[data-fixture-nav="session-dashboard"]').click()
  await projectDropNative(page, 'User project 项目', { version: 1, sessionId: 'hidden', displayTitle: 'Hidden fresh session' })
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'a determined project needs no second confirmation')
  const chinese = '会话已保存并符合当前视图；筛选条件保持不变。'
  const english = 'Session saved and matches the current view. Filters are unchanged.'
  await page.getByText(chinese, { exact: true }).waitFor()
  await page.evaluate(() => window.dashboardFixture.setLocale('en'))
  await page.getByText(english, { exact: true }).waitFor()
  assert.equal(await page.getByText(chinese, { exact: true }).count(), 0)
  await page.evaluate(() => window.dashboardFixture.setLocale('zh'))
  await page.getByText(chinese, { exact: true }).waitFor()
  assert.deepEqual(h.board().preferences, before, 'joining a card never rewrites the view preferences')
  // The join did happen; the only view lists the session inside its project expansion.
  await page.locator('.sd-projectcard').waitFor()
  // Sessions are visible inside the project's default expansion; opening one keeps it in place.
  const drop = await openProjectDrop(page, project.name)
  await drop.getByRole('button', { name: 'Hidden fresh session', exact: true }).click()
  const previewDialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await previewDialog.waitFor()
  await previewDialog.getByRole('button', { name: '会话详情', exact: true }).click()
  await page.getByRole('dialog', { name: '会话详情', exact: true }).waitFor()
  assert.equal(await page.locator('.sd-projectdrop').count() >= 1, true, 'opening a session keeps the inline expansion')
  assert.deepEqual(h.board().preferences, before, 'opening the joined session keeps the view preferences untouched')
  await page.getByRole('button', { name: '关闭会话详情', exact: true }).click()
  await page.getByRole('dialog', { name: '会话详情', exact: true }).waitFor({ state: 'detached' })
})

async function setup(t, name) {
  const h = await createFixture(t, runtime, name)
  await h.mutate({ type: 'create_project', name: 'User project 项目', color: '#5266c9', tagIds: [] })
  for (const name of ['Research 调研', 'Develop 开发', 'On hold 暂缓']) await h.mutate({ type: 'create_label', dimension: 'status', name, color: null })
  return { h, project: h.board().projects[0], statuses: h.board().statuses }
}

test('project-first membership button path and free atomic review destination use real authenticated RPC; locale switches live', async t => {
  const { h, project, statuses } = await setup(t, 'workflow-free-choice')
  setSource(h, 'review-work', sessionObservation('Review work', 'completed'))
  await h.openDashboard()
  const { page } = h
  const emptyProject = await openProjectDrop(page, 'User project 项目')
  await emptyProject.getByText('没有会话', { exact: true }).waitFor()
  await prepareNewSession(page, { sessionId: 'review-work', workspaceId: 'review-workspace' })
  const projectCard = page.getByRole('article', { name: 'User project 项目', exact: true })
  await projectCard.getByRole('button', { name: '项目操作：User project 项目', exact: true }).click()
  await projectCard.getByRole('group', { name: '项目操作：User project 项目', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click()
  await pickWorkspaceAndCreate(h)
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'the selected project applies in one step')
  await page.getByText('新会话已创建并加入项目。', { exact: true }).waitFor()
  assert.equal(h.board().cards.length, 1); assert.equal(h.card('review-work').decision, null)
  await closePreview(page)
  // Acceptance with a destination is the row chip's own pick, in one atomic review.
  const accept = await openStatePanel(page, 'Review work')
  await mutation(h, 'review', () => accept.getByRole('option', { name: statuses[2].name, exact: true }).click())
  assert.deepEqual(h.card('review-work').placement, { kind: 'custom', statusId: statuses[2].id })
  const history = await h.service.history({ sessionId: 'review-work', membershipId: h.card('review-work').membershipId, limit: 100 })
  assert.equal(history.records.filter(record => record.kind === 'accepted').length, 1)
  // A later state selection is not a second acceptance.
  const choose = await openStatePanel(page, 'Review work')
  await mutation(h, 'choose_state', () => choose.getByRole('option', { name: statuses[0].name, exact: true }).click())
  const later = await h.service.history({ sessionId: 'review-work', membershipId: h.card('review-work').membershipId, limit: 100 })
  assert.equal(later.records.filter(record => record.kind === 'accepted').length, 1, 'later state selection is not acceptance again')
  const chineseNotice = '状态已保存；不会启动或恢复 Agent，也不生成新的验收。'
  const englishNotice = 'Work state saved. No agent was started or resumed, and no new acceptance was recorded.'
  await page.getByText(chineseNotice, { exact: true }).waitFor()
  const writesBeforeLanguageChange = h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type !== 'preferences').length
  await page.evaluate(() => window.dashboardFixture.setLocale('en'))
  await page.getByText(englishNotice, { exact: true }).waitFor()
  assert.equal(await page.getByText(chineseNotice, { exact: true }).count(), 0)
  await page.evaluate(() => window.dashboardFixture.setLocale('zh'))
  await page.getByText(chineseNotice, { exact: true }).waitFor()
  assert.equal(await page.getByText(englishNotice, { exact: true }).count(), 0)
  assert.equal(h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type !== 'preferences').length, writesBeforeLanguageChange, 'changing locale only re-renders the existing notice; it never repeats work')
  await page.evaluate(() => window.dashboardFixture.setLocale('en'))
  await page.getByText(englishNotice, { exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Session Dashboard', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Project actions: User project 项目', exact: true }).click()
  const actions = page.getByRole('group', { name: 'Project actions: User project 项目', exact: true })
  await actions.getByRole('button', { name: 'Edit project', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.openSessionCalls), [], 'no flow starts, resumes or opens an agent')
  await h.screenshot('english-projects')
})
test('only acceptance then later state choice, pending new-run confirmation and cancellation remain execution-bound', async t => {
  const { h, project, statuses } = await setup(t, 'workflow-accept-only')
  setSource(h, 'work', sessionObservation('Bound work', 'completed', 'turn:1'))
  await h.join('work', project.id)
  await h.setEntry('projects')
  await h.page.goto('http://dashboard.test')
  await h.page.waitForFunction(() => Boolean(window.dashboardFixture))
  await h.page.locator('[data-fixture-nav="session-dashboard"]').click()
  const { page } = h
  await page.getByRole('button', { name: '会话行操作：Bound work', exact: true }).waitFor()
  // Dismissing the state picker is not a decision.
  let panel = await openStatePanel(page, 'Bound work')
  await page.keyboard.press('Escape')
  assert.equal(h.card('work').decision, null)
  // Acceptance stays one explicit, execution-bound write.
  panel = await openStatePanel(page, 'Bound work')
  await mutation(h, 'review', () => panel.getByRole('option', { name: '已验收', exact: true }).click())
  assert.deepEqual(h.card('work').placement, { kind: 'builtin', status: 'accepted' })
  // A later state selection is independent of acceptance.
  panel = await openStatePanel(page, 'Bound work')
  await mutation(h, 'choose_state', () => panel.getByRole('option', { name: statuses[0].name, exact: true }).click())
  assert.deepEqual(h.card('work').placement, { kind: 'custom', statusId: statuses[0].id })
  // A newer normally completed run parks the card in 待确认 and never auto-accepts it.
  setSource(h, 'work', sessionObservation('Bound work', 'completed', 'turn:2'))
  await h.mutate({ type: 'resync', sessionId: 'work' }); await refresh(h)
  await expectCardStatus(page, 'work', 'pending_confirm')
  const history = await h.service.history({ sessionId: 'work', membershipId: h.card('work').membershipId, limit: 100 })
  assert.equal(history.records.filter(record => record.kind === 'accepted').length, 1, 'a newer run never creates a second acceptance on its own')
  assert.equal(h.card('work').runtime.episodeId, 'turn:2')
})
test('narrow English project and state picker stay keyboard operable and fail closed on storage errors', async t => {
  const { h, project, statuses } = await setup(t, 'workflow-narrow-keyboard')
  setSource(h, 'work', sessionObservation('Keyboard work', 'completed'))
  await h.join('work', project.id)
  await h.setEntry('projects')
  await h.page.goto('http://dashboard.test')
  await h.page.waitForFunction(() => Boolean(window.dashboardFixture))
  await h.page.locator('[data-fixture-nav="session-dashboard"]').click()
  const { page } = h
  await page.getByRole('button', { name: '会话行操作：Keyboard work', exact: true }).waitFor()
  await page.setViewportSize({ width: 700, height: 800 })
  await page.evaluate(() => window.dashboardFixture.setLocale('en'))
  const chip = page.getByRole('button', { name: 'Change state: Keyboard work', exact: true })
  await chip.focus(); await page.keyboard.press('Enter')
  const panel = page.getByRole('listbox', { name: 'Change state: Keyboard work', exact: true })
  await panel.waitFor()
  h.failDatabaseWrites()
  await mutation(h, 'review', () => panel.getByRole('option', { name: statuses[2].name, exact: true }).click(), { ok: false })
  assert.equal(h.card('work').decision, null)
  h.allowDatabaseWrites()
  await chip.focus(); await page.keyboard.press('Enter')
  const retry = page.getByRole('listbox', { name: 'Change state: Keyboard work', exact: true })
  await retry.waitFor()
  await mutation(h, 'review', () => retry.getByRole('option', { name: statuses[2].name, exact: true }).click())
  assert.deepEqual(h.card('work').decision, { kind: 'accepted', episodeId: 'turn:1', at: h.card('work').decision.at })
  assert.deepEqual(h.card('work').placement, { kind: 'custom', statusId: statuses[2].id })
  await h.screenshot('narrow-english')
})
