import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeProjectDrop, createBrowserRuntime, createFixture, openMenu, openProjectDrop,
  sessionObservation,
} from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

const morePanel = page => page.getByRole('group', { name: '更多操作', exact: true })
const snapshotCalls = h => h.calls.filter(call => call.method === 'snapshot').length
const focusState = page => page.evaluate(() => ({
  label: document.activeElement?.getAttribute('aria-label') ?? null,
  kebab: Boolean(document.activeElement?.classList.contains('sd-kebab')),
  tag: document.activeElement?.tagName ?? null,
  home: Boolean(document.activeElement?.matches('[data-sd-home]')),
}))

/** Seeds real service state before the panel mounts so layout tests never depend on
 *  slow UI setup; all assertions still read the built native client in real Chrome. */
async function seedProject(h, { project, tags = [], tagGroups = [], members = {} }) {
  await h.mutate({ type: 'create_project', name: project, color: null, tagIds: tags.map(tag => tag.id) })
  const created = h.board().projects.find(row => row.name === project)
  for (const name of tagGroups) await h.mutate({ type: 'create_label', dimension: 'tag', name, color: null })
  const labels = tagGroups.map(name => h.board().tags.find(row => row.name === name))
  for (const [sessionId, tagName] of Object.entries(members)) {
    await h.join(sessionId, created.id)
    const card = h.board().cards.find(row => row.sessionId === sessionId)
    const tagIds = tagName === null ? [] : [labels.find(label => label.name === tagName).id]
    await h.mutate({ type: 'edit_card', sessionId, membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision, tagIds, titleOverride: card.titleOverride, progress: card.progress })
  }
  return { project: created, tags: labels }
}

async function createTag(h, name) {
  await h.mutate({ type: 'create_label', dimension: 'tag', name, color: null })
  return h.board().tags.find(tag => tag.name === name)
}

test('rare actions stay behind 更多操作; Escape restores focus, refresh runs once, project menu keeps only maintenance', async t => {
  const h = await createFixture(t, runtime, 'compact-menu')
  h.host.set('compact-alpha', sessionObservation('Compact Alpha'), false)
  const { project } = await seedProject(h, { project: 'Compact project', tagGroups: ['Compact tag'], members: { 'compact-alpha': 'Compact tag' } })
  await h.openDashboard()
  const { page } = h
  for (const name of ['刷新数据', '分类与排列']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `${name} must not be rendered until its menu opens`)
  const trigger = page.getByRole('button', { name: '更多操作', exact: true })
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')

  await trigger.click()
  const panel = morePanel(page)
  await panel.waitFor()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
  for (const name of ['刷新数据', '分类与排列']) await panel.getByRole('button', { name, exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.deepEqual(await focusState(page), { label: '更多操作', kebab: true, tag: 'BUTTON', home: false }, 'Escape closes the menu and hands focus back to its trigger')

  // A menu action must still refresh through the real RPC. The panel polls on a
  // 3s timer, so temporarily use the client's own visibility lifecycle to stop
  // background reads; the click must then be the only snapshot source.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await openMenu(page)
  const before = snapshotCalls(h)
  const next = h.nextCall(call => call.method === 'snapshot')
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await next
  await panel.waitFor({ state: 'detached' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(snapshotCalls(h), before + 1, 'one menu click triggers exactly one snapshot read')
  assert.equal(await page.evaluate(() => { const restored = delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); return restored }), true, 'the real visible-panel polling lifecycle is restored')

  // Management is opened from the menu, so its return target is the kebab.
  await openMenu(page)
  await page.getByRole('button', { name: '分类与排列', exact: true }).click()
  const manage = page.getByRole('dialog', { name: '分类与展示排列', exact: true })
  await manage.waitFor()
  await manage.getByRole('button', { name: '关闭分类与展示排列', exact: true }).click()
  await manage.waitFor({ state: 'hidden' })
  assert.deepEqual(await focusState(page), { label: '更多操作', kebab: true, tag: 'BUTTON', home: false }, 'closing classification management returns focus to 更多操作')

  // Project cards hide their actions too; opening one exposes the explicit destination.
  const projectTrigger = page.getByRole('button', { name: `项目操作：${project.name}`, exact: true })
  await projectTrigger.waitFor()
  assert.equal(await page.getByRole('button', { name: /^项目操作：/ }).count(), 1)
  assert.equal(await page.getByRole('group', { name: `项目操作：${project.name}`, exact: true }).count(), 0, 'a closed project menu renders no panel')
  await projectTrigger.click()
  const projectPanel = page.getByRole('group', { name: `项目操作：${project.name}`, exact: true })
  await projectPanel.waitFor()
  await projectPanel.getByRole('button', { name: '新建会话', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await projectPanel.waitFor({ state: 'detached' })
  assert.equal(await projectTrigger.evaluate(node => node === document.activeElement), true, 'project Escape returns focus to its own kebab')
})

test('bordered surfaces are restored; only the project dropdown header stays frameless', async t => {
  const h = await createFixture(t, runtime, 'compact-borderless')
  h.host.set('surface-alpha', sessionObservation('Surface Alpha'), false)
  h.host.set('surface-beta', sessionObservation('Surface Beta'), false)
  const seeded = await seedProject(h, { project: 'Surface project', tagGroups: ['Surface tag'], members: { 'surface-alpha': 'Surface tag', 'surface-beta': 'Surface tag' } })
  const tag = seeded.tags[0]
  const card = h.card('surface-alpha')
  await h.mutate({
    type: 'edit_card', sessionId: 'surface-alpha', membershipId: card.membershipId, expectedMetadataRevision: card.metadataRevision,
    tagIds: [tag.id], titleOverride: null, progress: 'Flat surface',
  })
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  const readStyles = selectors => page.evaluate(names => {
    const one = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const style = getComputedStyle(node)
      return {
        borderTopWidth: style.borderTopWidth, borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth, borderLeftWidth: style.borderLeftWidth,
        borderWidth: style.borderWidth, boxShadow: style.boxShadow, backgroundColor: style.backgroundColor,
      }
    }
    return Object.fromEntries(Object.entries(names).map(([key, selector]) => [key, one(selector)]))
  }, selectors)
  const borderKeys = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderWidth']
  const assertBorderless = (styles, label) => {
    for (const [name, style] of Object.entries(styles)) {
      assert(style, `${label}: ${name} must exist`)
      for (const key of borderKeys) assert.equal(style[key], '0px', `${label}: ${name}.${key} must not draw a border (${JSON.stringify(style)})`)
    }
  }
  const assertBordered = (styles, label) => {
    for (const [name, style] of Object.entries(styles)) {
      assert(style, `${label}: ${name} must exist`)
      for (const key of borderKeys.slice(0, 4)) assert.match(style[key], /^[1-9]\d*(\.\d+)?px$/, `${label}: ${name}.${key} must draw a border again (${JSON.stringify(style)})`)
    }
  }
  const assertOpaque = (style, label) => {
    assert.notEqual(style.backgroundColor, 'transparent', `${label} must use an opaque surface fill instead of a transparent hole`)
    const match = /^rgba?\(([^)]+)\)$/.exec(style.backgroundColor)
    assert(match, `${label} must report a concrete computed fill: ${style.backgroundColor}`)
    const channels = match[1].split(/[,/ ]+/).filter(Boolean).map(Number)
    assert.equal(channels.length === 3 ? 1 : channels[3], 1, `${label} must be fully opaque: ${style.backgroundColor}`)
  }

  await page.mouse.move(0, 0)
  const tagStyles = await readStyles({ tag: '.sd-tag' })
  assertBordered(tagStyles, 'session row tag')
  assert.equal(await page.locator('.sd-tag').count() > 0, true, 'tag pill must exist to prove its border is back')

  await page.locator('.sd-projectcard').waitFor()
  await page.mouse.move(0, 0)
  // The overview is a grid of fixed-width bordered tiles; only the dropdown header is
  // intentionally frameless, because that header is the surface the user asked to flatten.
  const overview = await readStyles({ project: '.sd-projectcard' })
  assertBordered(overview, 'projects overview')
  assertOpaque(overview.project, '.sd-projectcard')
  // Tags now live in the dropdown header instead of a second tile row, so they are
  // covered by the dropdown assertions below and by the session row tag above.

  // Sessions live in an inline expansion inside each project card. It is the deliberately
  // frameless area of the dropdown; only the session rows draw a hairline separator.
  await openProjectDrop(page, seeded.project.name)
  await page.mouse.move(0, 0)
  const dropdown = await readStyles({ drop: '.sd-projectdrop', first: '.sd-projectrow:first-child', second: '.sd-projectrow:nth-child(2)' })
  assertBorderless({ drop: dropdown.drop }, 'project dropdown')
  assert.equal(dropdown.drop.boxShadow, 'none', 'the inline expansion casts no overlay shadow')
  assertOpaque(dropdown.drop, '.sd-projectdrop')
  assert.equal(dropdown.first.borderTopWidth, '0px', 'the first session row has no separator above it')
  assert.equal(dropdown.second.borderTopWidth, '1px', 'session rows are separated by a hairline')
  const expansion = await page.locator(`[data-project-id="${seeded.project.id}"]`).evaluate(card => {
    const panel = card.querySelector('.sd-projectdrop')
    return { card: card.getBoundingClientRect().width, panel: panel.getBoundingClientRect().width }
  })
  assert(Math.abs(expansion.panel - (expansion.card - 2)) <= 1, `the expansion spans its project card: ${JSON.stringify(expansion)}`)
  const listOverflow = await page.locator('.sd-projectdrop-list').evaluate(node => ({ overflow: getComputedStyle(node).overflow, overflowY: getComputedStyle(node).overflowY }))
  assert(['auto', 'scroll'].includes(listOverflow.overflow), `the open dropdown list must scroll internally: ${JSON.stringify(listOverflow)}`)
  assert(['auto', 'scroll'].includes(listOverflow.overflowY), `the open dropdown list must scroll vertically inside: ${JSON.stringify(listOverflow)}`)
  await closeProjectDrop(page)
})
