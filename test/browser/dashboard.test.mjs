import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  addCard, closeDrawer, createBrowserRuntime, createFixture, createLabel, drawer,
  expectCardStatus, expandBucket, mutation, openMenu, openProjectDrop, openRowMenu,
  openStatePanel, persistedPreferences, refresh, sessionObservation,
} from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

const titles = ['Chrome Alpha delivery', 'Chrome Beta running', 'Chrome Gamma cross-workspace']
/** The drawer opens from the row menu only; the row title owns the preview. */
const openCard = async (page, title) => {
  const trigger = page.getByRole('button', { name: `会话行操作：${title}`, exact: true })
  if (await trigger.count() === 0) await expandBucket(page)
  const menu = await openRowMenu(page, title)
  await menu.getByRole('button', { name: '会话详情', exact: true }).click()
  await drawer(page).waitFor()
}
const assertText = async (locator, text) => { await locator.getByText(text, { exact: true }).waitFor() }

/** Acceptance is the row's own state chip now. */
async function acceptCard(h, title) {
  const trigger = h.page.getByRole('button', { name: `更改状态：${title}`, exact: true })
  if (await trigger.count() === 0) await expandBucket(h.page)
  const panel = await openStatePanel(h.page, title)
  await mutation(h, 'review', () => panel.getByRole('option', { name: '已验收', exact: true }).click())
}

async function archiveCard(h, title, archived) {
  const page = h.page
  const trigger = page.getByRole('button', { name: `会话行操作：${title}`, exact: true })
  if (await trigger.count() === 0) await expandBucket(page, archived ? 'unassigned' : 'archive')
  const menu = await openRowMenu(page, title, archived ? 'unassigned' : 'archive')
  await mutation(h, 'archive', () => menu.getByRole('button', { name: archived ? '归档' : '恢复到看板', exact: true }).click())
  assert.equal(await page.getByRole('dialog', { name: archived ? '归档会话卡片' : '恢复到看板', exact: true }).count(), 0, 'archive and restore apply without a confirmation dialog')
  await page.getByText(archived ? '已归档；运行与进度同步仍继续。' : '已恢复，展示当前最新进度。', { exact: true }).waitFor()
}

test('native apply registers matching root main/sidebar peers, empty board, unload and remount', async t => {
  const h = await createFixture(t, runtime, 'native-empty')
  h.host.set('existing-not-imported', sessionObservation('Existing but never imported'), false)
  await h.openDashboard()
  const { page } = h
  const slots = await page.evaluate(() => window.dashboardFixture.slots())
  assert.equal(slots.nativeRegistry, true, 'actual installed SlotRegistry, not a mock')
  assert.equal(slots.root, 1)
  assert.deepEqual(slots.main.map(entry => entry.key).sort(), ['fixture-session', 'plugins', 'session-dashboard'])
  assert.deepEqual(slots.sidebar, [
    { id: 'plugins', order: 3, label: '插件', locale: null },
    { id: 'session-dashboard', order: 4, label: '仪表板', locale: 'sessionDashboard' },
  ])
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.loadedIds), ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-locale', '@hsx/dsh-session-dashboard'])
  assert.equal(h.board().cards.length, 0, 'installing and opening must not import history')
  assert.equal(h.board().statuses.length, 0, 'no custom status or priority is seeded')
  await assertText(page, '还没有项目')
  assert.equal(h.board().preferences.entry, 'projects', 'new profiles open project overview without importing sessions')
  assert.equal(await page.getByRole('button', { name: '新建项目', exact: true }).count(), 1, 'the dashed grid tile is the only create-project entry point')
  assert.equal(await page.locator('[data-fixture-nav="session-dashboard"]').getAttribute('aria-pressed'), 'true')
  await h.screenshot('initial')

  await page.locator('[data-fixture-nav="plugins"]').click()
  await page.getByRole('heading', { name: 'Fixture Plugins', exact: true }).waitFor()
  await page.locator('[data-fixture-nav="session-dashboard"]').focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: '会话仪表板', exact: true }).waitFor()
  await page.evaluate(() => window.dashboardFixture.unloadDashboard())
  await page.locator('[data-fixture-nav="session-dashboard"]').waitFor({ state: 'detached' })
  const unloaded = await page.evaluate(() => ({ slots: window.dashboardFixture.slots(), stats: window.dashboardFixture.mountStats }))
  assert(!unloaded.slots.main.some(entry => entry.key === 'session-dashboard'))
  assert.deepEqual(unloaded.stats, { mounted: 1, unmounted: 1 })
  await page.evaluate(() => window.dashboardFixture.reloadDashboard())
  await page.locator('[data-fixture-nav="session-dashboard"]').click()
  await page.getByRole('heading', { name: '会话仪表板', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.dashboardFixture.slots())).main.filter(entry => entry.key === 'session-dashboard').length, 1, 'remount must not duplicate entries')
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.failures), [])
})

test('UI creates classifications, explicitly adds existing sessions, filters three groups, persists SQLite after service restart', async t => {
  const h = await createFixture(t, runtime, 'groups-persistence')
  h.host.set('alpha', sessionObservation(titles[0]), false)
  h.host.set('beta', { ...sessionObservation(titles[1], 'running'), workspace: '/same-workspace' }, false)
  h.host.set('gamma', { ...sessionObservation(titles[2]), workspace: '/another-workspace' }, false)
  await h.openDashboard()
  const { page } = h
  const project = await createLabel(h, 'project', 'Manual project Alpha')
  const otherProject = await createLabel(h, 'project', 'Manual project Beta')
  const weekday = await createLabel(h, 'tag', '周中优先')
  const weekend = await createLabel(h, 'tag', '周末优先')
  await addCard(h, { title: titles[0], project: project.name }); await closeDrawer(page)
  await addCard(h, { title: titles[1], project: otherProject.name }); await closeDrawer(page)
  await addCard(h, { title: titles[2], project: project.name }); await closeDrawer(page)
  assert.equal(h.board().cards.length, 3)
  for (const [sessionId, tagId] of [['alpha', weekday.id], ['beta', weekend.id]]) {
    const row = h.board().cards.find(card => card.sessionId === sessionId)
    await h.mutate({ type: 'edit_card', sessionId, membershipId: row.membershipId, expectedMetadataRevision: row.metadataRevision, tagIds: [tagId], titleOverride: row.titleOverride, progress: row.progress })
  }
  assert.deepEqual(h.card('alpha').tagIds, [weekday.id])
  assert.equal(h.card('alpha').projectId, h.card('gamma').projectId, 'different workspaces can share an explicitly chosen project')
  assert.notEqual(h.card('alpha').projectId, h.card('beta').projectId)
  await expectCardStatus(page, 'alpha', 'pending_review')
  await expectCardStatus(page, 'beta', 'in_progress')
  await h.screenshot('populated-status-board')

  // The removed candidate/add entries must not come back: the only dashboard
  // creation entry is each project card's New session.
  await openMenu(page)
  const more = page.getByRole('group', { name: '更多操作', exact: true })
  for (const name of ['添加会话', '已有会话候选']) assert.equal(await more.getByRole('button', { name, exact: true }).count(), 0, `${name} must not be a dashboard entry`)
  await page.keyboard.press('Escape')
  await more.waitFor({ state: 'detached' })
  assert.equal(h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type === 'add_card').length, 3)
  assert.equal(h.card('alpha').projectId, project.id)

  // 项目总览 is the only view: each project card lists only its own sessions.
  await page.locator('.sd-projectgrid').waitFor()
  const classifications = h.board().cards
  assert.equal(await page.locator('[data-card-id]').count(), 3)
  assert.equal(await page.getByRole('article', { name: project.name, exact: true }).locator('[data-card-id]').count(), 2, 'a project card lists only its own sessions')
  assert.equal(await page.getByRole('article', { name: otherProject.name, exact: true }).locator('[data-card-id]').count(), 1)
  assert.deepEqual(h.board().cards, classifications, 'viewing the overview must not mutate card data')
  const saved = h.board()
  assert.equal((await readFile(h.databasePath)).subarray(0, 16).toString(), 'SQLite format 3\u0000')
  await h.screenshot('project-overview')
  await h.restartService()
  await h.openDashboard()
  await expectCardStatus(page, 'alpha', 'pending_review')
  await expectCardStatus(page, 'beta', 'in_progress')
  assert.equal(await page.locator('[data-card-id]').count(), 3)
  // The restart reads the same durable row; order revisions are derived from the
  // single durable tag order, so compare the persisted identity and ids.
  const restored = h.board()
  assert.deepEqual(restored.cards, saved.cards)
  assert.deepEqual(restored.orders.status, saved.orders.status)
  assert.deepEqual(restored.orders.project.ids, saved.orders.project.ids)
  assert.deepEqual(restored.orders.tag.ids, saved.orders.tag.ids)
})
test('keyboard custom-status reorder preserves identifiers; explicit acceptance uses real host facts', async t => {
  const h = await createFixture(t, runtime, 'review-reorder')
  h.host.set('reviewed', sessionObservation('Keyboard reviewed session'), false)
  h.setReplay('reviewed', sessionObservation('Keyboard reviewed session'))
  await h.openDashboard()
  const { page } = h
  const project = await createLabel(h, 'project', 'Review project')
  await addCard(h, { title: 'Keyboard reviewed session', project: project.name })
  await closeDrawer(page)
  await openMenu(page)
  await page.getByRole('button', { name: '分类与排列', exact: true }).click()
  const manage = page.getByRole('dialog', { name: '分类与展示排列', exact: true })
  await manage.getByLabel('状态名称', { exact: true }).fill('Keyboard status one')
  await mutation(h, 'create_label', () => manage.getByRole('button', { name: '新建状态', exact: true }).click())
  await manage.getByLabel('状态名称', { exact: true }).fill('Keyboard status two')
  await mutation(h, 'create_label', () => manage.getByRole('button', { name: '新建状态', exact: true }).click())
  const identities = h.board().statuses.map(value => value.id)
  const reorder = manage.getByRole('button', { name: '前移Keyboard status two', exact: true })
  await reorder.focus()
  await mutation(h, 'reorder', () => page.keyboard.press('Enter'))
  await manage.getByRole('button', { name: '关闭分类与展示排列', exact: true }).click()
  // The row's own state picker lists the custom statuses in the durable order.
  let order = await openStatePanel(page, 'Keyboard reviewed session')
  assert.deepEqual(await order.getByRole('option').allTextContents().then(values => values.map(text => text.replace('✓', '').trim())), ['Keyboard status two', 'Keyboard status one', '已验收'])
  await page.keyboard.press('Escape')
  assert.deepEqual(h.board().orders.status.ids, ['in_progress', 'pending_confirm', 'pending_review', 'accepted', ...identities.toReversed()], 'keyboard reorder preserves durable status identities ahead of the unset bucket')

  // Acceptance is an explicit pick on the row chip, and it binds the host run.
  await acceptCard(h, 'Keyboard reviewed session')
  assert.equal(h.card('reviewed').status, 'accepted')
  assert.equal(h.card('reviewed').decision.kind, 'accepted')

  // A later normally completed run parks the card in 待确认; it never auto-accepts.
  await h.setObservation('reviewed', sessionObservation('Keyboard reviewed session', 'completed', 'turn:2', { cursor: 20, endedAt: 1735689602200 }), { completeReplay: true })
  await refresh(h)
  await expectCardStatus(page, 'reviewed', 'pending_confirm')
  await h.restartService()
  await h.openDashboard()
  order = await openStatePanel(page, 'Keyboard reviewed session')
  assert.deepEqual(await order.getByRole('option').allTextContents().then(values => values.map(text => text.replace('✓', '').trim())), ['Keyboard status two', 'Keyboard status one', '已验收'], 'the keyboard reorder survives a real service restart')
  await page.keyboard.press('Escape')
  assert.deepEqual(h.board().orders.status.ids, ['in_progress', 'pending_confirm', 'pending_review', 'accepted', ...identities.toReversed()], 'the keyboard reorder survives a real service restart')
  await expectCardStatus(page, 'reviewed', 'pending_confirm')
  await h.screenshot('persisted-order')
})
test('cold snapshots refuse acceptance; a newer host run must be looked at before it can be accepted', async t => {
  const h = await createFixture(t, runtime, 'cold-stale-review')
  h.host.set('cold', sessionObservation('Cold historical result', 'completed', 'turn:1', { sourceLive: false }), false)
  await h.openDashboard()
  const { page } = h
  await addCard(h, { title: 'Cold historical result', project: '未归属' })
  // A cold completed round is 待确认 only: opening it settles 待验收, but acceptance
  // still needs a live check and the row chip refuses without one.
  assert.equal(h.card('cold').status, 'pending_review')
  await closeDrawer(page)
  await expandBucket(page)
  const before = h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type === 'review').length
  await (await openStatePanel(page, 'Cold historical result')).getByRole('option', { name: '已验收', exact: true }).click()
  await page.waitForTimeout(250)
  assert.equal(h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type === 'review').length, before, 'a cold round cannot be accepted')
  assert.equal(h.card('cold').status, 'pending_review')
  await h.setObservation('cold', sessionObservation('Cold historical result'), { completeReplay: true })
  await refresh(h)
  await acceptCard(h, 'Cold historical result')
  assert.equal(h.card('cold').status, 'accepted')
  // A genuinely newer turn parks the accepted card in 待确认; nothing auto-accepts it.
  await h.setObservation('cold', sessionObservation('Cold historical result', 'completed', 'turn:2', { cursor: 20, endedAt: 1735689602200 }), { completeReplay: true })
  await refresh(h)
  await expectCardStatus(page, 'cold', 'pending_confirm')
  assert.equal(h.card('cold').runtime.episodeId, 'turn:2')
  await openCard(page, 'Cold historical result')
  await page.getByRole('button', { name: '关闭会话详情', exact: true }).click()
  await acceptCard(h, 'Cold historical result')
  assert.equal(h.card('cold').decision.episodeId, 'turn:2')
})
test('archive hides the card, background run still syncs, restore keeps current episode and classification', async t => {
  const h = await createFixture(t, runtime, 'archive-restored')
  h.host.set('archived', sessionObservation('Archived background work'), false)
  await h.openDashboard()
  const { page } = h
  const project = await createLabel(h, 'project', 'Archive project')
  const tag = await createLabel(h, 'tag', '周末优先')
  await addCard(h, { title: 'Archived background work', project: project.name })
  await drawer(page).getByLabel('一句话进展', { exact: true }).fill('Keep archive metadata')
  await mutation(h, 'edit_card', () => drawer(page).getByRole('button', { name: '保存字段', exact: true }).click())
  { const row = h.card('archived'); await h.mutate({ type: 'edit_card', sessionId: 'archived', membershipId: row.membershipId, expectedMetadataRevision: row.metadataRevision, tagIds: [tag.id], titleOverride: row.titleOverride, progress: row.progress }) }
  await refresh(h)
  await closeDrawer(page)
  // Archiving lives in the row menu.
  await archiveCard(h, 'Archived background work', true)
  assert.equal(h.card('archived').status, 'pending_review')
  assert(h.card('archived').archivedAt)
  await page.locator('.sd-projectrow[data-card-id="archived"]').waitFor({ state: 'detached' })
  await h.setObservation('archived', sessionObservation('Archived background work', 'running', 'turn:2'))
  assert.equal(h.card('archived').status, 'in_progress')
  await h.setObservation('archived', sessionObservation('Archived background work', 'completed', 'turn:2', { cursor: 20, endedAt: 1735689602200 }))
  assert.equal(h.card('archived').status, 'pending_confirm')
  const reviewAt = h.card('archived').reviewAt
  assert(h.card('archived').archivedAt, 'background completion must not unarchive')
  // Restore lives in the archive bucket's row menu.
  await archiveCard(h, 'Archived background work', false)
  assert.equal(h.card('archived').archivedAt, null)
  assert.equal(h.card('archived').runtime.episodeId, 'turn:2')
  assert.equal(h.card('archived').reviewAt, reviewAt)
  assert.equal(h.card('archived').projectId, project.id)
  assert.deepEqual(h.card('archived').tagIds, [tag.id])
  assert.equal(h.card('archived').progress, 'Keep archive metadata')
  await page.locator('.sd-projectrow[data-card-id="archived"]').waitFor()
  await h.screenshot('latest-episode')
})
// Removed with the feature: "移出看板" no longer exists anywhere in the UI.
test('unsaved draft guard, real SQLite save failure, and retry preserve input plus independently updated lifecycle', async t => {
  const h = await createFixture(t, runtime, 'draft-save-retry')
  h.host.set('draft', sessionObservation('Draft editing work'), false)
  await h.openDashboard()
  const { page } = h
  await addCard(h, { title: 'Draft editing work', project: '未归属' })
  const draft = 'Unsaved Unicode 进展 remains after failed SQLite transaction'
  await drawer(page).getByLabel('一句话进展', { exact: true }).fill(draft)
  await drawer(page).getByRole('button', { name: '关闭会话详情', exact: true }).click()
  const guard = page.getByRole('dialog', { name: '有未保存的修改', exact: true })
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await drawer(page).getByLabel('一句话进展', { exact: true }).inputValue(), draft)
  assert.equal(h.card('draft').progress, '')

  await h.setObservation('draft', sessionObservation('Draft editing work', 'running', 'turn:2'))
  await h.setObservation('draft', sessionObservation('Draft editing work', 'completed', 'turn:2', { cursor: 20, endedAt: 1735689602200 }))
  const expectedRuntime = h.card('draft').runtime
  await refresh(h)
  assert.equal(await drawer(page).getByLabel('一句话进展', { exact: true }).inputValue(), draft)
  h.failDatabaseWrites()
  const failed = await mutation(h, 'edit_card', () => drawer(page).getByRole('button', { name: '保存字段', exact: true }).click(), { ok: false })
  assert.match(failed.result.error.message, /browser-fixture-disk-write-failure/)
  await page.getByRole('alert').getByText(/修改未成功，草稿仍保留/).waitFor()
  assert.equal(await drawer(page).getByLabel('一句话进展', { exact: true }).inputValue(), draft)
  assert.equal(h.card('draft').progress, '', 'failed SQL transaction must not persist input')
  assert.deepEqual(h.card('draft').runtime, expectedRuntime, 'a metadata failure must not roll back independent host facts')
  h.allowDatabaseWrites()
  await mutation(h, 'edit_card', () => drawer(page).getByRole('button', { name: '保存字段', exact: true }).click())
  assert.equal(h.card('draft').progress, draft)
  assert.deepEqual(h.card('draft').runtime, expectedRuntime)
  await closeDrawer(page)
  await h.restartService()
  await h.openDashboard()
  await openCard(page, 'Draft editing work')
  assert.equal(await drawer(page).getByLabel('一句话进展', { exact: true }).inputValue(), draft)
  await h.screenshot('persisted')
})

test('the panel draft survives peer navigation and is discarded explicitly; no view starts a session', async t => {
  const h = await createFixture(t, runtime, 'native-navigation')
  h.host.set('navigate', sessionObservation('Navigate fixture only', 'waiting_input'), false)
  await h.openDashboard()
  const { page } = h
  const project = await createLabel(h, 'project', 'Navigation project')
  await addCard(h, { title: 'Navigate fixture only', project: project.name })
  await closeDrawer(page)
  await openCard(page, 'Navigate fixture only')
  const text = 'Retain draft across native panel navigation'
  await drawer(page).getByLabel('一句话进展', { exact: true }).fill(text)
  // Peer navigation is host-owned; panel-local draft lives in DashboardClient, not React mount.
  await page.evaluate(() => document.querySelector('[data-fixture-nav="plugins"]').click())
  await page.getByRole('heading', { name: 'Fixture Plugins', exact: true }).waitFor()
  await page.locator('[data-fixture-nav="session-dashboard"]').click()
  await drawer(page).waitFor()
  assert.equal(await drawer(page).getByLabel('一句话进展', { exact: true }).inputValue(), text)
  await drawer(page).getByRole('button', { name: '关闭会话详情', exact: true }).click()
  await page.getByRole('dialog', { name: '有未保存的修改', exact: true }).getByRole('button', { name: '放弃草稿并继续', exact: true }).click()
  await drawer(page).waitFor({ state: 'hidden' })
  assert.equal(h.card('navigate').progress, '')
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.openSessionCalls), [], 'viewing the overview or details never opens, starts or resumes an agent')
})
test('D03 trusted blocked, paused, disarmed and cancellation reasons stay visible with honest session-only next steps', async t => {
  const h = await createFixture(t, runtime, 'runtime-reasons')
  const cases = [
    ['blocked', 'Blocked reason visible', 'suspended', '目标已阻塞，等待人工处理或恢复', '进入会话恢复'],
    ['paused', 'Paused reason visible', 'suspended', '目标已暂停，等待恢复', '进入会话恢复'],
    ['disarmed', 'Disarmed reason visible', 'suspended', '活动目标在当前进程未获续跑授权，需人工恢复', '进入会话恢复'],
    ['cancelled', 'Cancelled reason visible', 'interrupted', '活动目标已取消，尚无后续完整正常执行', '处理中断'],
    ['input', 'Input reason visible', 'waiting_input', '宿主正在等待用户输入', '去回答'],
    ['approval', 'Approval reason visible', 'waiting_approval', '宿主正在等待用户授权', '去授权'],
  ]
  for (const [id, title, phase, explanation] of cases) h.host.set(id, sessionObservation(title, phase, 'turn:1', { explanation }), false)
  await h.openDashboard()
  const { page } = h
  const project = await createLabel(h, 'project', 'Runtime reasons project')
  for (const [id] of cases) { await h.join(id, project.id); assert.equal(h.card(id).status, 'in_progress') }
  await refresh(h)
  // The drawer repeats the read-only reason and next step; the removed board was
  // the only surface that grew a navigation action from it.
  for (const [id, title, phase, explanation] of cases) {
    await openCard(page, title)
    const details = drawer(page)
    await assertText(details, explanation)
    await details.getByText(phase === 'suspended' ? /进入会话.*不会自动恢复/ : phase === 'interrupted' ? /中断或取消/ : phase === 'waiting_input' ? /不提供原地答复/ : /不能直接批准/).waitFor()
    assert.equal(await details.getByRole('button', { name: /进入会话恢复|去回答|去授权|处理失败|处理中断/ }).count(), 0, 'the drawer does not duplicate a card action')
    await closeDrawer(page)
    await page.getByRole('dialog', { name: '会话详情', exact: true }).waitFor({ state: 'detached' })
  }
  assert.equal(h.board().tags.length, 0, 'runtime facts are not synthesized ordinary tags')
  assert.deepEqual(await page.evaluate(() => window.dashboardFixture.openSessionCalls), [], 'runtime reasons never open, start or resume an agent on their own')
})
test('D05 an empty custom status list is created through management and returns to its preserved scroll location', async t => {
  const h = await createFixture(t, runtime, 'status-empty-create', { viewport: { width: 760, height: 700 } })
  await h.mutate({ type: 'create_project', name: 'Status project', color: null, tagIds: [] })
  const project = h.board().projects.find(value => value.name === 'Status project')
  for (let index = 0; index < 9; index++) { h.host.set(`unset-${index}`, sessionObservation(`Unclassified card ${index}`), false); await h.join(`unset-${index}`, project.id) }
  // The single overview owns the only scroll-preference location.
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await page.getByRole('article', { name: 'Status project', exact: true }).locator('.sd-projectrow').first().waitFor()
  assert.equal(h.board().statuses.length, 0)
  const before = h.board().cards
  const trigger = page.getByRole('button', { name: '更多操作', exact: true })
  await trigger.click()
  await page.getByRole('button', { name: '分类与排列', exact: true }).click()
  let manage = page.getByRole('dialog', { name: '分类与展示排列', exact: true })
  assert.equal(await manage.getByRole('button', { name: '状态', exact: true }).getAttribute('aria-pressed'), 'true', 'the status section is the default category view')
  assert.equal(await manage.getByRole('region', { name: '优先级' }).count(), 0, 'priorities no longer have their own management section')
  await manage.getByRole('button', { name: '关闭分类与展示排列', exact: true }).click()
  assert.equal(h.board().statuses.length, 0, 'entering management never seeds choices')
  await persistedPreferences(h, prefs => prefs.locations.projects.y > 200, () => page.locator('.sd-scroll').evaluate(node => { node.scrollTop = 240 }))
  const beforeY = await page.locator('.sd-scroll').evaluate(node => node.scrollTop)
  await trigger.click()
  await page.getByRole('button', { name: '分类与排列', exact: true }).click()
  manage = page.getByRole('dialog', { name: '分类与展示排列', exact: true })
  await manage.getByLabel('状态名称', { exact: true }).fill('自定义关注分组')
  await mutation(h, 'create_label', () => manage.getByRole('button', { name: '新建状态', exact: true }).click())
  await manage.getByRole('button', { name: '关闭分类与展示排列', exact: true }).click()
  assert.equal(await page.locator('.sd-scroll').evaluate(node => node.scrollTop), beforeY)
  assert.equal(h.board().statuses.length, 1)
  assert.deepEqual(h.board().cards, before, 'creating a status never reassigns the existing cards')
  const focusTarget = await page.evaluate(() => {
    const active = document.activeElement
    if (active?.matches('[data-sd-home]')) return 'home'
    return active?.matches('button.sd-kebab') && active.getAttribute('aria-label') === '更多操作' ? 'more' : null
  })
  assert(['home', 'more'].includes(focusTarget), 'closing management returns focus to the dashboard heading or the persistent 更多操作 menu trigger, never body')
})
test('initial RPC failure is not empty state; visible retry recovers the real service snapshot', async t => {
  const h = await createFixture(t, runtime, 'load-retry', { initialFailure: true })
  await h.openDashboard()
  const { page } = h
  await page.getByRole('heading', { name: '无法加载仪表板', exact: true }).waitFor()
  assert.equal(await page.getByText('还没有项目', { exact: true }).count(), 0)
  await page.getByText('加载失败不代表没有数据。请重试，已有元数据不会被清除。', { exact: true }).waitFor()
  assert(h.calls.some(call => call.method === 'snapshot' && !call.result.ok && call.result.error.message === 'fixture initial transport unavailable'))
  h.setInitialFailure(false)
  const next = h.nextCall(call => call.method === 'snapshot' && call.result.ok)
  await page.getByRole('button', { name: '重试加载', exact: true }).click()
  await next
  await assertText(page, '还没有项目')
  assert.equal(h.board().cards.length, 0)
})
