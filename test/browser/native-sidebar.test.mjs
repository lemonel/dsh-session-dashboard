import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createNativeSidebarRuntime, nativeDrag, resolveNativeSidebarSdk } from '../tools/native-sidebar-harness.mjs'

let runtime
before(async () => { runtime = await createNativeSidebarRuntime() })
after(async () => { await runtime?.close() })
const row = (page, id) => page.locator(`[data-row-key="session:${id}"]`)
const handle = (page, id = 'native-a') => page.locator(`[data-sd-native-session="${id}"]`)
const noNativeSideEffects = async (fixture, baseline, expected = {}) => {
  const actual = await fixture.snapshot()
  assert.deepEqual(actual.browserView, baseline.browserView, 'Plugin drag/click must not alter native order or order mode')
  assert.deepEqual(actual.visibleOrder, baseline.visibleOrder, 'Passing other native rows must not reorder them')
  for (const key of ['retained', 'created', 'selected', 'execution', 'workspaceMutation']) assert.deepEqual(actual.calls[key], baseline.calls[key], `${key} must not open/create/start/reorder a native Session`)
  assert.equal(actual.calls.joined.length, expected.joined ?? baseline.calls.joined.length)
  assert.equal(actual.calls.drops.length, expected.drops ?? baseline.calls.drops.length)
  assert.deepEqual(actual.failures, [])
}

test('native sidebar SDK resolution rejects a missing explicit source without fallback', async () => {
  await assert.rejects(resolveNativeSidebarSdk('/path-that-does-not-contain-dashboard-sdk'), /ENOENT/)
})

test('complete real WorkspaceBrowser/SessionNodeItem receives only the public plugin entry', async t => {
  const f = await runtime.fixture(t, 'real-owner')
  const state = await f.snapshot()
  assert.equal(state.realSlotRegistry, true)
  assert.deepEqual(state.sourceModuleExports, ['apply', 'inject'], 'No private component export is injected into the native factory')
  assert(state.loaded.includes('@deepseek-ai/dsh-client-ui-workspace'))
  assert.equal(state.slotCounts['sidebar.workspaces.session.row.action'], 1)
  assert.equal(state.slotCounts['sidebar.workspaces.session.menu.item'], 0, 'the native actions menu keeps only its own rows')
  assert.equal(await handle(f.page).count(), 1)
  assert.equal(await row(f.page, 'native-a').getAttribute('draggable'), 'true', 'The native parent drag is intact, not disabled to make the test pass')
  assert.deepEqual(state.calls.retained, [], 'Rendering a row must not retain/open the Session')
})

for (const groupBy of ['workspace', 'flat']) {
  for (const orderBy of ['updated', 'manual']) {
    test(`dedicated handle cancel/invalid/native-row drops keep ${groupBy}/${orderBy} order and selection`, async t => {
      const f = await runtime.fixture(t, `${groupBy}-${orderBy}-cancel`, { groupBy, orderBy })
      const { page } = f
      const baseline = await f.snapshot()
      await nativeDrag(page, handle(page), [row(page, 'native-b'), row(page, 'native-c')], page.locator('[data-invalid-drop]'), { cancel: true })
      await noNativeSideEffects(f, baseline)
      await nativeDrag(page, handle(page), [row(page, 'native-b'), row(page, 'native-c')], page.locator('[data-invalid-drop]'))
      await noNativeSideEffects(f, baseline)
      await nativeDrag(page, handle(page), [row(page, 'native-b')], row(page, 'native-c'))
      await noNativeSideEffects(f, baseline)
      // A valid native browser drag proves stopPropagation did not cancel dragstart.
      await nativeDrag(page, handle(page), [row(page, 'native-b'), row(page, 'native-c')], page.locator('[data-drop-project]'))
      await page.waitForFunction(() => window.nativeSidebarFixture.evidence().calls.drops.length === 1)
      await noNativeSideEffects(f, baseline, { drops: 1 })
      const current = await f.snapshot()
      assert.deepEqual(current.calls.drops[0].source, { version: 1, sessionId: 'native-a', displayTitle: '原生会话 Alpha' })
      assert.deepEqual(current.calls.drops[0].types, ['application/x-session-dashboard-native-session'])
      assert.equal(current.calls.drops[0].plainText, '', 'The plugin never uses the native sorting text/plain channel')
      assert.equal(current.calls.drops[0].projectId, 'fixture-project')
    })
  }
}

test('control: untouched native whole-row drag still reorders and switches updated to manual', async t => {
  const f = await runtime.fixture(t, 'native-control', { groupBy: 'flat' })
  const baseline = await f.snapshot()
  // This is deliberately NOT the plugin drag handle: it exercises native source
  // and parent state to ensure the other tests do not mock away sorting behavior.
  const source = row(f.page, 'native-a').locator('span').filter({ hasText: '原生会话 Alpha' }).first()
  await nativeDrag(f.page, source, [row(f.page, 'native-b')], row(f.page, 'native-c'))
  await f.page.waitForFunction(() => window.nativeSidebarFixture.evidence().browserView.orderBy === 'manual')
  const actual = await f.snapshot()
  assert.notDeepEqual(actual.visibleOrder, baseline.visibleOrder)
  assert.equal(actual.calls.drops.length, 0)
  assert.equal(actual.calls.joined.length, 0)
})

test('public row click and keyboard call one shared workflow and dynamically follow locale', async t => {
  const f = await runtime.fixture(t, 'keyboard-locale')
  const { page } = f
  const baseline = await f.snapshot()
  await row(page, 'native-a').hover()
  await handle(page).click()
  await noNativeSideEffects(f, baseline, { joined: 1 })
  await handle(page).focus()
  await page.keyboard.press('Enter')
  await noNativeSideEffects(f, baseline, { joined: 2 })
  await page.keyboard.press('Space')
  await noNativeSideEffects(f, baseline, { joined: 3 })
  await page.evaluate(() => window.nativeSidebarFixture.setLanguage('en'))
  assert.equal(await handle(page).getAttribute('aria-label'), 'Add to project: 原生会话 Alpha')
  assert.equal(await handle(page).getAttribute('title'), 'Drag to a project, or click to choose a project')
  await row(page, 'native-a').getByRole('button', { name: 'Session actions for 原生会话 Alpha', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: 'Add to project', exact: true }).count(), 0, 'the plugin no longer adds a menu row')
  await page.evaluate(() => window.nativeSidebarFixture.setLanguage('zh'))
  assert.equal(await handle(page).getAttribute('aria-label'), '加入项目: 原生会话 Alpha')
  assert.equal(await handle(page).getAttribute('title'), '拖动到项目，或点击选择项目')
  assert.equal(await page.getByRole('menuitem', { name: '加入项目', exact: true }).count(), 0)
  const calls = (await f.snapshot()).calls.joined
  assert(calls.every(call => call.sessionId === 'native-a' && call.displayTitle === '原生会话 Alpha'))
})

test('strict plugin MIME payload refuses native plain IDs, extra keys, bad versions and oversized input', async t => {
  const f = await runtime.fixture(t, 'payload-boundary')
  const inputs = ['native-a', '"native-a"', '{', JSON.stringify({ version: 1, sessionId: 'native-a' }), JSON.stringify({ version: 2, sessionId: 'native-a', displayTitle: '' }), JSON.stringify({ version: 1, sessionId: 'native-a', displayTitle: '', generation: 'fake' }), JSON.stringify({ version: 1, sessionId: '', displayTitle: '' }), JSON.stringify({ version: 1, sessionId: 'x'.repeat(241), displayTitle: '' }), JSON.stringify({ version: 1, sessionId: 'native-a', displayTitle: 'x'.repeat(1001) }), ' '.repeat(8193)]
  assert.deepEqual(await f.page.evaluate(values => values.map(value => window.nativeSidebarFixture.parse(value)), inputs), inputs.map(() => null))
  assert.deepEqual(await f.page.evaluate(() => window.nativeSidebarFixture.parse(JSON.stringify({ version: 1, sessionId: 'native-a', displayTitle: '' }))), { version: 1, sessionId: 'native-a', displayTitle: '' })
})

test('public owner absence, two replacements, disable/re-enable and narrow/collapsed surfaces retain a fallback', async t => {
  const f = await runtime.fixture(t, 'lifecycle-fallback', { width: 640 })
  const { page } = f
  for (let round = 0; round < 2; round++) {
    await page.evaluate(() => window.nativeSidebarFixture.reloadPlugin())
    assert.equal((await f.snapshot()).slotCounts['sidebar.workspaces.session.row.action'], 1)
    assert.equal(await handle(page).count(), 1)
  }
  await page.evaluate(() => window.nativeSidebarFixture.unloadPlugin())
  assert.equal((await f.snapshot()).slotCounts['sidebar.workspaces.session.row.action'], 0)
  assert.equal(await handle(page).count(), 0)
  await page.locator('[data-fallback-candidates]').click()
  assert.equal((await f.snapshot()).calls.joined.at(-1).fallback, true)
  await page.evaluate(() => window.nativeSidebarFixture.reloadPlugin())
  assert.equal(await handle(page).count(), 1)
  await page.evaluate(() => window.nativeSidebarFixture.unloadOwner())
  assert.equal((await f.snapshot()).slotCounts['sidebar.workspaces.session.row.action'], 0)
  await page.locator('[data-fallback-candidates]').click()
  await page.evaluate(() => window.nativeSidebarFixture.reloadOwner())
  await handle(page).waitFor({ state: 'attached' })
  await row(page, 'native-a').hover()
  await handle(page).waitFor()
  assert.equal((await f.snapshot()).slotCounts['sidebar.workspaces.session.row.action'], 1)
  await page.evaluate(() => window.nativeSidebarFixture.setWide(false))
  await handle(page).waitFor({ state: 'hidden' })
  await page.locator('[data-fallback-candidates]').click()
  await page.evaluate(() => window.nativeSidebarFixture.setWide(true))
  await row(page, 'native-a').hover()
  await handle(page).waitFor()
  assert.equal((await f.snapshot()).slotCounts['sidebar.workspaces.session.menu.item'], 0)
})

test('A02 native source reaches production project overview/header and shared Membership via actual Gateway', async t => {
  const { createFixture, mutation, refresh, sessionObservation } = await import('../tools/browser-harness.mjs')
  const h = await createFixture(t, runtime, 'actual-gateway-membership', { nativeSidebarRuntime: runtime })
  const { page } = h
  for (const [id, title] of [['native-a', '原生会话 Alpha'], ['native-b', '原生会话 Bravo']]) h.host.set(id, sessionObservation(title, 'not_started'), false)
  await h.mutate({ type: 'create_project', name: 'Native project', color: null, tagIds: [] })
  const project = h.board().projects[0]
  await refresh(h)
  const baseline = await h.nativeFixture.snapshot()
  const overviewTarget = page.locator(`[data-project-id="${project.id}"]`)
  // A target-less row action still opens the shared dialog; cancel writes nothing.
  await row(page, 'native-a').hover()
  await handle(page).click()
  const dialog = page.getByRole('dialog', { name: '加入或移动到项目', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(h.board().cards.length, 0, 'Cancel leaves membership untouched')
  // Dropping onto a project card names the target, so it applies in one step.
  await mutation(h, 'add_card', () => nativeDrag(page, handle(page), [row(page, 'native-b'), row(page, 'native-c')], overviewTarget))
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'a determined project applies without confirmation')
  assert.equal(h.board().cards.length, 1)
  assert.equal(h.card('native-a').projectId, project.id)
  assert.equal(h.card('native-a').decision, null, 'Adding a native session does not manufacture acceptance')
  assert.equal(h.card('native-a').runtime.phase, 'not_started', 'Adding never starts execution')
  await nativeDrag(page, handle(page, 'native-b'), [row(page, 'native-c')], page.locator('[data-sd-home]'))
  assert.equal(h.board().cards.length, 1, 'Dropping on a non-target heading does not add a relation')
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0)
  await mutation(h, 'add_card', () => nativeDrag(page, handle(page, 'native-b'), [row(page, 'native-c')], overviewTarget))
  assert.equal(h.board().cards.length, 2, 'the project card is the one-step production membership target')
  assert.equal(h.card('native-b').projectId, project.id)
  assert.equal(h.card('native-b').decision, null)
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0)
  await page.getByRole('button', { name: '会话行操作：原生会话 Bravo', exact: true }).waitFor()
  const after = await h.nativeFixture.snapshot()
  assert.deepEqual(after.browserView, baseline.browserView)
  assert.deepEqual(after.visibleOrder, baseline.visibleOrder)
  for (const key of ['retained', 'created', 'selected', 'execution', 'workspaceMutation']) assert.deepEqual(after.calls[key], baseline.calls[key], key)
  assert.equal(h.calls.filter(call => call.method === 'mutate' && call.args.mutation.command.type === 'add_card').length, 2)
  assert(h.calls.some(call => call.method === 'inspectSession' && call.result.ok))
  assert.equal(h.calls.some(call => call.method === 'navigation'), false)
})
