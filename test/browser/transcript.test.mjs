import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserRuntime, createFixture, sessionObservation } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

const messages = [
  { id: 'u1', role: 'user', time: 1735689600000, parts: [{ type: 'text', text: 'Hello from the session' }] },
  { id: 'a1', role: 'assistant', time: 1735689600100, parts: [{ type: 'reasoning', text: 'hidden thought' }, { type: 'text', text: 'Assistant answer' }, { type: 'tool-call', name: 'read_file', arguments: '{"path":"a"}' }] },
  { id: 't1', role: 'tool', time: 1735689600200, parts: [{ type: 'tool-result', name: 'read_file', text: 'file body', isError: false }] },
]

async function setup(t, name = 'transcript-preview') {
  const h = await createFixture(t, runtime, name, { viewport: { width: 1400, height: 1000 } })
  await h.mutate({ type: 'create_project', name: 'Preview project', color: null, tagIds: [] })
  const project = h.board().projects.find(value => value.name === 'Preview project')
  h.host.set('preview-session', sessionObservation('Preview session'), false)
  h.host.set('preview-session-2', sessionObservation('Second session'), false)
  await h.join('preview-session', project.id)
  await h.join('preview-session-2', project.id)
  h.host.transcripts.set('preview-session', { messages, truncated: false })
  await h.setEntry('projects')
  await h.openDashboard()
  await h.page.locator('.sd-projectcard').waitFor()
  return { h, page: h.page }
}

test('a project session opens the real native Session page in a wide floating frame', async t => {
  const { h, page } = await setup(t)
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.waitFor()
  const frame = dialog.locator('iframe.sd-native-page')
  await frame.waitFor()
  const src = await frame.getAttribute('src')
  assert.ok(src?.includes('session-dashboard-preview=preview-session'), `the frame asks the plugin inside it to open the exact Session: ${src}`)
  const box = await dialog.boundingBox()
  assert(box.width > 800, `the native page uses a wide second-layer window: ${JSON.stringify(box)}`)
  assert.equal(await dialog.locator('.sd-projectcard').count(), 0, 'the preview chrome carries no project cards')
  assert.equal(await h.page.evaluate(() => window.dashboardFixture.openSessionCalls.length), 0, 'preview never opens the host session by itself')
})

test('the preview expands to nearly full screen and restores the original size', async t => {
  const { page } = await setup(t, 'transcript-expand')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.waitFor()
  const pane = dialog.locator('.sd-preview-pane')
  const before = await pane.boundingBox()
  assert.ok(before)
  await dialog.getByRole('button', { name: '全屏查看（解除宽度限制）', exact: true }).click()
  await page.waitForTimeout(150)
  const expanded = await pane.boundingBox()
  assert.ok(expanded)
  assert.ok(expanded.width > before.width + 100, `expanded width grew: ${JSON.stringify({ before, expanded })}`)
  assert.ok(expanded.width > 1200, `expanded preview is nearly the viewport width: ${expanded.width}`)
  assert.ok(expanded.height > 800, `expanded preview is nearly the viewport height: ${expanded.height}`)
  const frame = await dialog.locator('iframe.sd-native-page').boundingBox()
  assert.ok(frame && frame.height > 700, `the iframe itself grows: ${JSON.stringify(frame)}`)
  await dialog.getByRole('button', { name: '恢复预览大小', exact: true }).click()
  await page.waitForTimeout(100)
  const restored = await pane.boundingBox()
  assert.ok(restored && restored.width < 1100, `the original window returns: ${JSON.stringify(restored)}`)
})

test('the mask beside the floating window closes it while a press inside does not', async t => {
  const { page } = await setup(t, 'transcript-backdrop')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.waitFor()
  const box = await dialog.boundingBox()
  const overlay = await page.locator('[data-preview-cache]').boundingBox()
  assert.ok(box && overlay)
  assert.ok(box.x - overlay.x > 40, `the deck hugs the windows, leaving a real mask beside them: ${JSON.stringify({ box, overlay })}`)
  // A press inside the window (its head, its iframe, its buttons) changes nothing.
  await page.mouse.click(box.x + 40, box.y + 40)
  await page.waitForTimeout(120)
  assert.equal(await page.locator('[data-preview-cache]').isVisible(), true, 'inside presses never close the window')
  // The mask beside the window closes it exactly like the close control.
  await page.mouse.click(overlay.x + 20, box.y + 40)
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
})

test('the preview opens from the project row title and keeps its read-only entry points', async t => {
  const { page } = await setup(t, 'transcript-nested')
  const row = page.locator('[data-card-id="preview-session"]')
  await row.locator('.sd-projectrow-title').click()
  let preview = page.getByRole('dialog', { name: '预览会话', exact: true })
  await preview.waitFor()
  // The preview keeps its own details entry; the drawer no longer reopens it.
  await preview.getByRole('button', { name: '会话详情', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
  const details = page.getByRole('dialog', { name: '会话详情', exact: true })
  await details.waitFor()
  assert.equal(await details.getByRole('button', { name: '预览会话', exact: true }).count(), 0, 'the drawer no longer opens the preview')
  await details.getByRole('button', { name: '关闭会话详情', exact: true }).click()
  await details.waitFor({ state: 'detached' })
  // The native tab boots cold, so seed the session catalogue it will report. Also
  // remember a dashboard panel in the shared origin storage: the link-opened tab's
  // automatic Session reveal must not clear that last-panel preference.
  await page.evaluate(() => {
    localStorage.setItem('fixture:session-ids', JSON.stringify(['preview-session', 'preview-session-2']))
    localStorage.setItem('session-dashboard:last-panel', 'session-dashboard')
  })
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  preview = page.getByRole('dialog', { name: '预览会话', exact: true })
  await preview.waitFor()
  const enter = preview.getByRole('link', { name: '在新标签打开会话核对结果 ↗', exact: true })
  assert.equal(await enter.getAttribute('target'), '_blank', 'the enter action is a real new-tab link')
  assert.match(await enter.getAttribute('rel') ?? '', /noopener/)
  const href = new URL(await enter.getAttribute('href'))
  assert.equal(href.searchParams.get('session-dashboard-open'), 'preview-session')
  assert.equal(href.searchParams.get('session-dashboard-preview'), null, 'the frame-only preview marker is dropped')

  const popupEvent = page.context().waitForEvent('page')
  await enter.click()
  const popup = await popupEvent
  const popupErrors = []
  popup.on('pageerror', error => popupErrors.push(error.message))
  await popup.waitForLoadState('domcontentloaded')
  const popupUrl = new URL(popup.url())
  assert.equal(popupUrl.searchParams.get('session-dashboard-open'), 'preview-session', 'the new tab carries the requested Session')
  assert.equal(popupUrl.searchParams.get('session-dashboard-preview'), null)
  // The new tab is a normal plugin page: the dashboard entry and main panel are
  // registered instead of an early return that only opened the Session.
  await popup.waitForFunction(() => {
    const slots = window.dashboardFixture?.slots()
    return Boolean(slots?.sidebar.some(entry => entry.id === 'session-dashboard'))
      && Boolean(slots?.main.some(entry => entry.key === 'session-dashboard'))
  }, undefined, { timeout: 15000 })
  assert.equal(await popup.evaluate(() => window.dashboardFixture.mountStats.mounted), 1, 'the new tab mounts the dashboard remote once')
  assert.equal(await popup.evaluate(() => document.querySelector('aside[aria-label="Fixture host navigation"]') !== null), true, 'the new tab keeps the complete native shell navigation')
  await popup.waitForFunction(() => window.dashboardFixture?.openSessionCalls.includes('preview-session'), undefined, { timeout: 15000 })
  // Give the cold-boot correction window a chance to run before counting opens.
  await popup.waitForTimeout(400)
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.openSessionCalls), ['preview-session'], 'the catalogue wait opens the Session once, not once per event')
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.panelSelections), [null], 'the native conversation becomes the active panel')
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.failures), [], 'the new tab reports no plugin errors')
  // A catalogue event can be published before native retention reports the reveal
  // the tab just made. The tab must wait out its settle window instead of repeating
  // the same open; only a genuinely different Session is corrected.
  await popup.evaluate(() => window.dashboardFixture.bootRestore(null))
  await popup.waitForTimeout(700)
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.openSessionCalls), ['preview-session'], 'a stale catalogue event never repeats the same reveal')
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.panelSelections), [null], 'the stale event does not reselect the panel')
  // A late native boot restore is corrected by the catalogue subscription...
  await popup.evaluate(() => window.dashboardFixture.bootRestore('preview-session-2'))
  await popup.waitForFunction(() => window.dashboardFixture.openSessionCalls.length === 2, undefined, { timeout: 5000 })
  // ...but the user's own first press ends that correction for good: switching to
  // the dashboard entry must never be pulled back to the Session afterwards.
  await popup.locator('[data-fixture-nav="session-dashboard"]').click()
  await popup.locator('[data-sd-home]').waitFor()
  await popup.evaluate(() => window.dashboardFixture.bootRestore('preview-session-2'))
  await popup.waitForTimeout(400)
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.openSessionCalls), ['preview-session', 'preview-session'], 'the user wins: no further open after a real interaction')
  assert.deepEqual(await popup.evaluate(() => window.dashboardFixture.panelSelections), [null, null], 'the correction reasserts the native panel exactly once')
  assert.equal(await popup.locator('[data-sd-home]').isVisible(), true, 'the dashboard panel stays visible after the user opened it')
  assert.equal(await page.evaluate(() => localStorage.getItem('session-dashboard:last-panel')), 'session-dashboard', 'the link-opened tab never clears the shared dashboard panel preference')
  assert.deepEqual(popupErrors, [], 'the new tab must not report uncaught page errors')
  assert.equal(await page.evaluate(() => window.dashboardFixture.openSessionCalls.length), 0, 'the current page never navigates; only the new tab opens the Session')
  assert.equal(await preview.isVisible(), true, 'the preview stays open in the current page')
  await popup.close()
})

test('project session rows drop their bottom actions; the title previews and the row menu opens details', async t => {
  const { h, page } = await setup(t, 'transcript-row-menu')
  const row = page.locator('[data-card-id="preview-session"]')
  await row.locator('.sd-projectrow-title').waitFor()
  assert.equal(await row.locator('.sd-projectrow-actions').count(), 0, 'the bottom action row is removed')
  assert.equal(await row.locator(':scope > *').count(), 3, 'the row keeps only its head, state line and tags line')
  assert.equal(await row.getByRole('button', { name: '预览会话', exact: true }).count(), 0)
  assert.equal(await row.getByRole('button', { name: '会话详情', exact: true }).count(), 0)
  assert.equal(await row.getByRole('button', { name: '预览会话：Preview session', exact: true }).count(), 0, 'the old preview action is gone')
  assert.equal(await row.getByRole('button', { name: '打开详情：Preview session', exact: true }).count(), 0, 'the old details action is gone')

  await row.locator('.sd-projectrow-title').click()
  const preview = page.getByRole('dialog', { name: '预览会话', exact: true })
  await preview.waitFor()
  await preview.getByRole('button', { name: '关闭预览会话', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })

  await row.getByRole('button', { name: '会话行操作：Preview session', exact: true }).click()
  const menu = page.getByRole('group', { name: '会话行操作：Preview session', exact: true })
  await menu.waitFor()
  assert.equal(await menu.getByRole('button').first().textContent(), '进入会话', 'entering the session is the first menu entry')
  assert.equal((await menu.getByRole('button').allTextContents())[1], '会话详情', 'details stays one entry below it')
  await menu.getByRole('button', { name: '会话详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情', exact: true })
  await details.waitFor()
  assert.equal(await h.page.evaluate(() => window.dashboardFixture.openSessionCalls.length), 0, 'details do not navigate the host by themselves')
})

test('closing and reopening the same preview reuses the already-booted native frame', async t => {
  const { page } = await setup(t, 'transcript-cache')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.waitFor()
  const frame = page.locator('iframe.sd-native-page')
  await frame.waitFor()
  await frame.evaluate(element => element.setAttribute('data-preview-reused', 'yes'))
  await dialog.getByRole('button', { name: '关闭预览会话', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('iframe.sd-native-page').count(), 1, 'the hidden frame remains mounted during the cache window')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('iframe.sd-native-page').getAttribute('data-preview-reused'), 'yes', 'reopening does not boot another native client')
})

test('the preview head picks a second session while the deck hides and the dashboard stays usable', async t => {
  const { page } = await setup(t, 'transcript-pick-split')
  await page.locator('[data-card-id="preview-session"] .sd-projectrow-title').click()
  let dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.waitFor()
  const primary = dialog.locator('iframe.sd-native-page')
  await primary.waitFor()
  const primarySrc = await primary.getAttribute('src')
  assert.ok(primarySrc?.includes('session-dashboard-preview=preview-session'))
  await primary.evaluate(element => element.setAttribute('data-primary-reused', 'yes'))

  // The explicit pick entry hides the deck without destroying the primary client.
  await dialog.getByRole('button', { name: '并排打开另一个会话', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
  const bar = page.locator('.sd-split-pickbar')
  await bar.waitFor()
  assert.match(await bar.textContent(), /请选择另一个会话来并排/)
  assert.equal(await page.locator('iframe.sd-native-page').count(), 1, 'the primary native client stays mounted while picking')
  assert.equal(await page.locator('[data-card-id="preview-session-2"] .sd-projectrow-title').isVisible(), true, 'the dashboard behind the hidden deck is interactive')

  // Clicking another session title completes the pick: primary restored plus one
  // temporary second pane, exactly like the toast's side-by-side action.
  await page.locator('[data-card-id="preview-session-2"] .sd-projectrow-title').click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'visible' })
  await page.locator('.sd-preview-panes[data-panes="2"]').waitFor()
  assert.equal(await bar.count(), 0, 'the pick prompt disappears once the second pane exists')
  const sources = await page.locator('iframe.sd-native-page').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')))
  assert.equal(sources.length, 2, 'exactly two native clients are mounted')
  assert.ok(sources[0]?.includes('session-dashboard-preview=preview-session'), 'the original Session stays on the left')
  assert.ok(sources[1]?.includes('session-dashboard-preview=preview-session-2'), 'the picked Session loads as the second pane')
  assert.equal(await page.locator('.sd-preview-pane[data-primary="true"] iframe.sd-native-page').getAttribute('data-primary-reused'), 'yes', 'the primary client was hidden, not rebooted')

  // Closing only the side pane destroys only that frame.
  await page.getByRole('button', { name: '关闭这个窗格', exact: true }).click()
  await page.locator('.sd-preview-panes[data-panes="1"]').waitFor()
  assert.equal(await page.locator('iframe.sd-native-page').count(), 1, 'the temporary second pane is gone')
  assert.ok((await page.locator('iframe.sd-native-page').getAttribute('src'))?.includes('session-dashboard-preview=preview-session'), 'the primary client remains')

  // Escape cancels a pick instead of closing the whole preview.
  dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  await dialog.getByRole('button', { name: '并排打开另一个会话', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await page.locator('[data-preview-cache]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('.sd-split-pickbar').count(), 0)
  assert.equal(await page.locator('.sd-preview-pane').count(), 1, 'cancelling restores the original single-pane preview')
  await dialog.getByRole('button', { name: '关闭预览会话', exact: true }).click()
  await page.locator('[data-preview-cache]').waitFor({ state: 'hidden' })
})

test('switching conversations navigates one native frame instead of racing several', async t => {
  const { page } = await setup(t, 'transcript-switch')
  const openFor = async (id) => {
    await page.locator(`[data-card-id="${id}"] .sd-projectrow-title`).click()
    const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
    await dialog.waitFor()
    return dialog
  }
  let dialog = await openFor('preview-session')
  let frame = dialog.locator('iframe.sd-native-page')
  await frame.waitFor()
  const source = await frame.getAttribute('src')
  await dialog.getByRole('button', { name: '关闭预览会话', exact: true }).click()
  dialog = await openFor('preview-session-2')
  assert.equal(await dialog.locator('iframe.sd-native-page').count(), 1, 'the new conversation reuses the single native frame')
  assert.equal(await dialog.locator('iframe.sd-native-page').getAttribute('src'), source, 'navigation does not reload the native client')
  await dialog.getByRole('button', { name: '关闭预览会话', exact: true }).click()
  dialog = await openFor('preview-session')
  assert.equal(await dialog.locator('iframe.sd-native-page').count(), 1)
  assert.equal(await dialog.locator('iframe.sd-native-page').getAttribute('src'), source)
  // Revisiting the Session that seeded the frame URL is still a switch: the frame
  // kept showing preview-session-2, so the parent must navigate it again.
  const previewFrame = page.frames().find(value => value.url().includes('session-dashboard-preview=preview-session'))
  assert.ok(previewFrame, 'the preview frame is a real document that can report its navigations')
  await previewFrame.waitForFunction(() => {
    const list = window.dashboardFixture.previewNavigations
    return list.lastIndexOf('preview-session') > list.lastIndexOf('preview-session-2') && list.filter(id => id === 'preview-session').length >= 2
  })
  await dialog.getByRole('button', { name: '关闭预览会话', exact: true }).click()
})

test('refresh reloads the native page without changing the Session', async t => {
  const { h, page } = await setup(t, 'transcript-status')
  await page.getByRole('button', { name: 'Preview session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览会话', exact: true })
  const frame = dialog.locator('iframe.sd-native-page')
  await frame.waitFor()
  const before = await frame.getAttribute('src')
  await dialog.getByRole('button', { name: '刷新', exact: true }).click()
  await dialog.locator('iframe.sd-native-page').waitFor()
  assert.equal(await dialog.locator('iframe.sd-native-page').getAttribute('src'), before)
  assert.equal(h.host.transcripts.size > 0, true, 'the backend transcript seam remains available for other consumers')
  assert.equal(await h.page.evaluate(() => window.dashboardFixture.openSessionCalls.length), 0)
})
