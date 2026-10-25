import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY } from '../../lib/shared/model.js'
import {
  createBrowserRuntime, createFixture, mutation, sessionObservation,
} from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

const TILE_WIDTH = 340, PANEL_HEIGHT = 300
const name = (prefix, index) => `${prefix} ${index}`

async function createProjects(h, names) {
  for (const value of names) await h.mutate({ type: 'create_project', name: value, color: null, tagIds: [] })
  return names.map(value => h.board().projects.find(project => project.name === value))
}

async function addSessions(h, projectId, prefix, count) {
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${index}`
    h.host.set(id, sessionObservation(`${prefix} session ${index}`), false)
    await h.join(id, projectId)
  }
}

async function openOverview(h) {
  await h.setEntry('projects')
  await h.openDashboard()
  await h.page.locator('.sd-projectcard').first().waitFor()
}

const toggleFor = (page, id) => page.locator(`[data-project-id="${id}"] .sd-projecttoggle`)
const roundTop = value => Math.round(value * 2) / 2

function groupRows(cards) {
  const rows = new Map()
  for (const card of cards) {
    const top = roundTop(card.top)
    if (!rows.has(top)) rows.set(top, [])
    rows.get(top).push(card)
  }
  return rows
}

function readGrid(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.sd-projectgrid')
    return {
      gridWidth: grid.clientWidth,
      rowCardsWidth: grid.querySelector('.sd-projectgroup-cards')?.getBoundingClientRect().width ?? 0,
      cards: [...document.querySelectorAll('.sd-projectcard')].map(card => {
        const rect = card.getBoundingClientRect(), panel = card.querySelector('.sd-projectdrop')
        const panelRect = panel?.getBoundingClientRect()
        return {
          id: card.dataset.projectId, width: rect.width, top: rect.top, bottom: rect.bottom, left: rect.left,
          expanded: card.dataset.expanded === 'true',
          panel: panelRect ? { width: panelRect.width, left: panelRect.left, top: panelRect.top, bottom: panelRect.bottom, height: panelRect.height, position: getComputedStyle(panel).position } : null,
        }
      }),
      panels: document.querySelectorAll('.sd-projectdrop').length,
      pageWidth: document.documentElement.clientWidth,
      pageFull: document.documentElement.scrollWidth,
    }
  })
}

test('project tiles stay 340px in wrapping rows and collapse to one fluid column at 760px', async t => {
  const h = await createFixture(t, runtime, 'project-grid-tiles', { viewport: { width: 1400, height: 1000 } })
  const projects = await createProjects(h, Array.from({ length: 6 }, (_, index) => name('Tiles project', index)))
  await openOverview(h)
  const { page } = h

  const wide = await readGrid(page)
  assert.equal(wide.cards.length, projects.length, 'every project renders exactly one tile')
  for (const card of wide.cards) assert(Math.abs(card.width - TILE_WIDTH) <= 0.5, `every project tile is a fixed ${TILE_WIDTH}px card: ${JSON.stringify(card)}`)
  const wideRows = groupRows(wide.cards)
  assert(wideRows.size >= 2, `six tiles at 1400px must wrap onto multiple rows, tops: ${JSON.stringify([...wideRows.keys()])}`)
  for (const [top, row] of wideRows) for (const card of row) assert(Math.abs(card.top - top) <= 0.5, `tiles sharing a row share one top offset: ${JSON.stringify(row)}`)
  for (const row of wideRows.values()) {
    const ordered = [...row].sort((left, right) => left.left - right.left)
    for (let index = 1; index < ordered.length; index += 1) assert(ordered[index].left >= ordered[index - 1].left + TILE_WIDTH - 0.5, `tiles in a row must not overlap: ${JSON.stringify(ordered)}`)
  }
  assert.equal(wide.pageFull, wide.pageWidth, 'wrapping fixed-width tiles must not widen the document')

  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForFunction(width => {
    const cards = [...document.querySelectorAll('.sd-projectcard')]
    return cards.length > 0 && cards.every(card => card.getBoundingClientRect().width > width + 100)
  }, TILE_WIDTH)
  const narrow = await readGrid(page)
  assert.equal(narrow.cards.length, projects.length)
  assert(narrow.cards.every(card => card.width > TILE_WIDTH + 100), `narrow tiles must not stay at the fixed ${TILE_WIDTH}px: ${JSON.stringify(narrow.cards.map(card => card.width))}`)
  assert(narrow.cards.every(card => Math.abs(card.width - narrow.rowCardsWidth) <= 1), `one-column tiles fill the available width (${JSON.stringify(narrow.cards.map(card => card.width))} vs ${narrow.rowCardsWidth})`)
  assert.equal(groupRows(narrow.cards).size, projects.length, 'a <=760px viewport must place exactly one project per row')
  assert.equal(narrow.pageFull, narrow.pageWidth, 'the single column must not widen the document')
})

test('every project expands by default with a sessions area exactly as wide as its own tile', async t => {
  const h = await createFixture(t, runtime, 'project-grid-aligned', { viewport: { width: 1400, height: 900 } })
  const projects = await createProjects(h, Array.from({ length: 6 }, (_, index) => name('Aligned project', index)))
  await addSessions(h, projects[0].id, 'aligned', 3)
  await openOverview(h)
  const { page } = h

  const grid = await readGrid(page)
  assert.equal(grid.panels, projects.length, 'all projects start expanded')
  for (const card of grid.cards) {
    assert.equal(card.expanded, true, `project ${card.id} must start expanded`)
    assert(card.panel, `project ${card.id} must render its sessions area`)
    assert(Math.abs(card.panel.width - (card.width - 2)) <= 1, `the expansion must span its project card inside the 1px border: ${JSON.stringify({ card: card.width, panel: card.panel.width })}`)
    assert(Math.abs(card.panel.left - (card.left + 1)) <= 1, `the expansion must align to its project card's border: ${JSON.stringify({ cardLeft: card.left, panelLeft: card.panel.left })}`)
    assert.equal(card.panel.position, 'static', 'the expansion stays in normal flow inside the card')
    assert(card.panel.top >= card.top && card.panel.bottom <= card.bottom + 0.5, 'the panel grows inside its own card')
  }

  const rows = [...groupRows(grid.cards).values()]
  assert(rows.length >= 2)
  const firstRow = rows[0], secondRow = rows[1]
  const firstRowBottom = Math.max(...firstRow.map(card => card.bottom))
  assert(secondRow[0].top >= firstRowBottom - 0.5, `the next row starts below the expanded first row: ${JSON.stringify({ secondRowTop: secondRow[0].top, firstRowBottom })}`)
  const secondRowTopBefore = secondRow[0].top

  for (const card of firstRow) await toggleFor(page, card.id).click()
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-project-id="${id}"]`).dataset.expanded !== 'true'), firstRow.map(card => card.id))
  const collapsed = await readGrid(page)
  const secondRowAfter = collapsed.cards.find(card => card.id === secondRow[0].id)
  assert(secondRowAfter.top < secondRowTopBefore - 200, `collapsing the first row must pull the next row up: ${JSON.stringify({ before: secondRowTopBefore, after: secondRowAfter.top })}`)

  for (const card of firstRow) await toggleFor(page, card.id).click()
  await page.waitForFunction(count => document.querySelectorAll('.sd-projectdrop').length === count, projects.length)
})

test('the expansion keeps a fixed 300px height and scrolls its session list inside', async t => {
  const h = await createFixture(t, runtime, 'project-grid-fixed', { viewport: { width: 1400, height: 800 } })
  const projects = await createProjects(h, ['Crowded project', 'Single project', 'Empty project'])
  await addSessions(h, projects[0].id, 'crowded', 12)
  await addSessions(h, projects[1].id, 'single', 1)
  await openOverview(h)
  const { page } = h

  const heights = await page.evaluate(() => [...document.querySelectorAll('.sd-projectcard')].map(card => {
    const panel = card.querySelector('.sd-projectdrop'), list = panel?.querySelector('.sd-projectdrop-list')
    const rect = panel.getBoundingClientRect()
    return { id: card.dataset.projectId, height: rect.height, width: rect.width, cardWidth: card.getBoundingClientRect().width, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflowY: getComputedStyle(list).overflowY }
  }))
  for (const panel of heights) {
    assert(Math.abs(panel.height - PANEL_HEIGHT) <= 1, `every expansion keeps the same fixed height (${panel.id}: ${panel.height})`)
    assert(Math.abs(panel.width - (panel.cardWidth - 2)) <= 1, `the expansion width follows the project card (${panel.id})`)
  }
  const crowded = heights.find(panel => panel.id === projects[0].id)
  assert(['auto', 'scroll'].includes(crowded.overflowY), 'the session list scrolls internally')
  assert(crowded.scrollHeight > crowded.clientHeight, `twelve sessions exceed the fixed height (${crowded.scrollHeight} vs ${crowded.clientHeight})`)

  const pageBefore = await page.locator('.sd-scroll').evaluate(node => node.scrollTop)
  const box = await page.locator(`[data-project-id="${projects[0].id}"] .sd-projectdrop-list`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 20)
  await page.mouse.wheel(0, 300)
  await page.waitForFunction(id => document.querySelector(`[data-project-id="${id}"] .sd-projectdrop-list`).scrollTop > 0, projects[0].id)
  const after = await page.evaluate(() => ({
    list: document.querySelector('.sd-projectdrop-list').scrollTop,
    page: document.querySelector('.sd-scroll').scrollTop,
    panels: document.querySelectorAll('.sd-projectdrop').length,
  }))
  assert(after.list > 0, 'wheel input scrolls the fixed-height list')
  assert.equal(after.page, pageBefore, 'the inner list contains overscroll; the page must not move')
  assert.equal(after.panels, projects.length, 'scrolling inside the list expands nothing away')
})

test('the last row expands downward in place and stays reachable by ordinary scrolling', async t => {
  const h = await createFixture(t, runtime, 'project-grid-bottom', { viewport: { width: 1000, height: 700 } })
  const projects = await createProjects(h, Array.from({ length: 12 }, (_, index) => name('Bottom project', index)))
  const last = projects.at(-1)
  await addSessions(h, last.id, 'bottom', 12)
  await openOverview(h)
  const { page } = h

  await page.locator('.sd-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
  await page.waitForFunction(() => {
    const scroll = document.querySelector('.sd-scroll')
    return scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1
  })
  const lastCard = await page.locator(`[data-project-id="${last.id}"]`).evaluate(node => {
    const rect = node.getBoundingClientRect(), panel = node.querySelector('.sd-projectdrop')
    const panelRect = panel.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, panelTop: panelRect.top, panelBottom: panelRect.bottom, panelHeight: panelRect.height, position: getComputedStyle(panel).position }
  })
  assert.equal(lastCard.position, 'static', 'the last row uses the same in-flow expansion')
  assert(Math.abs(lastCard.panelHeight - PANEL_HEIGHT) <= 1, 'the last row keeps the fixed height')
  assert(lastCard.panelTop >= lastCard.top, 'the expansion starts below its project header')
  assert(lastCard.panelBottom > lastCard.panelTop)
  assert.equal(await page.locator('.sd-projectdrop').count(), projects.length, 'all projects remain expanded')
})

test('clicking a project collapses only that project; Escape collapses from inside', async t => {
  const h = await createFixture(t, runtime, 'project-grid-toggle', { viewport: { width: 1200, height: 800 } })
  const projects = await createProjects(h, ['Toggle one', 'Toggle two', 'Toggle three'])
  await openOverview(h)
  const { page } = h
  const first = projects[0], second = projects[1]

  await toggleFor(page, first.id).click()
  await page.locator(`[data-project-id="${first.id}"] .sd-projectdrop`).waitFor({ state: 'detached' })
  assert.equal(await toggleFor(page, second.id).getAttribute('aria-expanded'), 'true', 'collapsing one project leaves the others expanded')
  assert.equal(await page.locator('.sd-projectdrop').count(), projects.length - 1)

  await toggleFor(page, first.id).click()
  const panel = page.locator(`[data-project-id="${first.id}"] .sd-projectdrop`)
  await panel.waitFor()
  assert.equal(await toggleFor(page, first.id).getAttribute('aria-expanded'), 'true')

  await panel.focus()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await toggleFor(page, first.id).evaluate(node => document.activeElement === node), true, 'Escape returns focus to the project title')

  await toggleFor(page, first.id).click()
  await page.locator(`[data-project-id="${first.id}"] .sd-projectdrop`).waitFor()
  assert.equal(await page.getByRole('button', { name: '加入本项目', exact: true }).count(), 0, 'the project toolbar must not repeat the title-bar add action')
})

test('the card menu only maintains the project and deleting it keeps its sessions as unassigned', async t => {
  const h = await createFixture(t, runtime, 'project-delete', { viewport: { width: 1200, height: 800 } })
  const projects = await createProjects(h, ['Delete me', 'Keep me'])
  await addSessions(h, projects[0].id, 'kept', 2)
  await openOverview(h)
  const { page } = h
  const card = page.locator(`[data-project-id="${projects[0].id}"]`)
  await card.getByRole('button', { name: '项目操作：Delete me', exact: true }).click()
  const menu = page.getByRole('group', { name: '项目操作：Delete me', exact: true })
  assert.ok(await menu.getByRole('button', { name: '新建会话', exact: true }).count() === 1, 'creating is project-bound from the card menu')
  assert.ok(await menu.getByRole('button', { name: '编辑项目', exact: true }).count() === 1)
  await menu.getByRole('button', { name: '删除项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除项目“Delete me”？', exact: true })
  await dialog.waitFor()
  assert.match(await dialog.textContent(), /会话会变为未归属/)
  assert.equal(h.board().projects.length, 2, 'opening the confirmation deletes nothing')

  const call = await mutation(h, 'delete_project', () => dialog.getByRole('button', { name: '确认删除项目', exact: true }).click())
  assert.equal(call.args.mutation.command.projectId, projects[0].id)
  assert.equal(call.args.mutation.command.confirmed, true)
  await dialog.waitFor({ state: 'hidden' })
  const board = call.result.value.board
  assert.equal(board.projects.length, 1, 'only the selected project is removed')
  assert.equal(board.projects[0].id, projects[1].id)
  assert.equal(board.cards.length, 2, 'the sessions stay tracked')
  assert.deepEqual(board.cards.map(row => row.projectId), [null, null], 'its sessions become unassigned instead of deleted')
  await page.locator(`[data-project-id="${projects[0].id}"]`).waitFor({ state: 'detached' })
  assert.equal(await page.locator('.sd-projectcard').count(), 1)
  await page.getByText('项目已删除；其中的会话已变为未归属，聊天未删除。', { exact: true }).waitFor()
})

const readRowGroups = page => page.evaluate(() => [...document.querySelectorAll('.sd-projectgroup')].map(row => ({
  ids: [...row.querySelectorAll('.sd-projectcard')].map(card => card.dataset.projectId),
  expanded: row.querySelector('.sd-projectgroup-toggle')?.getAttribute('aria-expanded') ?? null,
  label: row.querySelector('.sd-projectgroup-toggle')?.getAttribute('aria-label') ?? null,
  ghost: row.querySelector('.sd-ghostcard') !== null,
})))

async function startProjectDrag(page, fromId) {
  const grip = await page.locator(`[data-project-id="${fromId}"] .sd-projectcard-head .sd-projectgrip`).boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + 24, grip.y + 24, { steps: 4 })
}

async function dragOnto(page, toId, edge = 'before') {
  const box = await page.locator(`[data-project-id="${toId}"]`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, edge === 'before' ? box.y + 10 : box.y + 50, { steps: 10 })
}

test('the row rail collapses and expands that whole row only, including a mixed row', async t => {
  const h = await createFixture(t, runtime, 'project-row-rail', { viewport: { width: 1400, height: 900 } })
  const projects = await createProjects(h, Array.from({ length: 6 }, (_, index) => name('Rail project', index)))
  await openOverview(h)
  const { page } = h
  const rows = await readRowGroups(page)
  assert(rows.length >= 2, `six projects must form several rows: ${JSON.stringify(rows)}`)
  const first = rows[0], second = rows[1]
  assert.equal(first.expanded, 'true', 'rows start expanded with the cards')
  assert.equal(first.label, `收起本行 ${first.ids.length} 个项目`)
  const guide = await page.locator('.sd-projectgroup').first().evaluate(row => {
    const line = getComputedStyle(row, '::before'), hook = getComputedStyle(row, '::after'), card = row.querySelector('.sd-projectcard').getBoundingClientRect(), toggle = row.querySelector('.sd-projectgroup-toggle').getBoundingClientRect()
    return { content: line.content, height: line.height, left: line.left, right: line.right, top: line.top, hook: hook.content, transform: hook.transform, rowTop: row.getBoundingClientRect().top, cardTop: card.top, toggle: { width: toggle.width, height: toggle.height, border: getComputedStyle(row.querySelector('.sd-projectgroup-toggle')).borderTopWidth, background: getComputedStyle(row.querySelector('.sd-projectgroup-toggle')).backgroundColor } }
  })
  assert.notEqual(guide.content, 'none', 'the row draws a guide line')
  assert.equal(guide.height, '1px')
  assert.equal(guide.left, '6px'); assert.equal(guide.right, '2px')
  assert.equal(guide.top, '-2px', 'the guide line hugs the top edge of the cards')
  assert(guide.rowTop + Number.parseFloat(guide.top) <= guide.cardTop, 'the guide line stays above the card tops')
  assert.deepEqual(guide.toggle, { width: 18, height: 20, border: '0px', background: 'rgba(0, 0, 0, 0)' }, 'the row control is a small borderless icon, not a stretched pill')
  assert.notEqual(guide.hook, 'none', 'the row guide turns down into a radical-shaped hook')
  assert.match(guide.transform, /matrix/)

  const rowButton = (index, label) => page.locator('.sd-projectgroup').nth(index).getByRole('button', { name: label, exact: true })
  await rowButton(0, `收起本行 ${first.ids.length} 个项目`).click()
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-project-id="${id}"]`)?.dataset.expanded !== 'true'), first.ids)
  const collapsed = await readRowGroups(page)
  assert.equal(collapsed[0].expanded, 'false')
  assert.equal(collapsed[0].label, `展开本行 ${first.ids.length} 个项目`)
  assert.equal(collapsed[1].expanded, 'true', 'the next row is not affected by the first row rail')
  for (const id of second.ids) assert.equal(await page.locator(`[data-project-id="${id}"] .sd-projectdrop`).count(), 1)

  await rowButton(0, `展开本行 ${first.ids.length} 个项目`).click()
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-project-id="${id}"]`)?.dataset.expanded === 'true'), first.ids)

  // A mixed row reports the remaining action and expands the whole row in one click.
  await toggleFor(page, first.ids[0]).click()
  await page.waitForFunction(id => document.querySelector(`[data-project-id="${id}"]`)?.dataset.expanded !== 'true', first.ids[0])
  const mixed = await readRowGroups(page)
  assert.equal(mixed[0].expanded, 'false')
  assert.equal(mixed[0].label, `展开本行 ${first.ids.length} 个项目`)
  await rowButton(0, `展开本行 ${first.ids.length} 个项目`).click()
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-project-id="${id}"]`)?.dataset.expanded === 'true'), first.ids)
  assert.equal((await readRowGroups(page)).length, rows.length, 'row toggling never changes the row count')
})

test('dragging a project grip previews the drop layout, and the arrow keys remain equivalent', async t => {
  const h = await createFixture(t, runtime, 'project-reorder', { viewport: { width: 1400, height: 900 } })
  const projects = await createProjects(h, ['Order A', 'Order B', 'Order C', 'Order D', 'Order E', 'Order F'])
  await addSessions(h, projects[0].id, 'order', 2)
  await openOverview(h)
  const { page } = h
  const ids = projects.map(project => project.id)
  const domOrder = () => page.evaluate(() => [...document.querySelectorAll('.sd-projectcard')].map(card => card.dataset.projectId))
  const expectOrder = async expected => {
    await page.waitForFunction(value => JSON.stringify([...document.querySelectorAll('.sd-projectcard')].map(card => card.dataset.projectId)) === JSON.stringify(value), expected)
    assert.deepEqual(await domOrder(), expected)
    assert.deepEqual(h.board().orders.project.ids.filter(id => id !== EMPTY), expected)
    assert.equal(h.board().orders.project.ids.at(-1), EMPTY, 'the unassigned sentinel stays last')
  }

  assert.deepEqual(await domOrder(), ids)
  await startProjectDrag(page, ids[0])
  await dragOnto(page, ids[2], 'after')
  await page.waitForFunction(() => [...document.querySelectorAll('.sd-projectcard')].some(card => card.getAnimations().length > 0), null, { timeout: 1000 })
  const preview = await domOrder()
  assert.deepEqual(preview, [ids[1], ids[2], ids[0], ids[3], ids[4], ids[5]], 'the grid previews the post-drop layout before release')
  assert.deepEqual(h.board().orders.project.ids.filter(id => id !== EMPTY), ids, 'the preview is not committed before the pointer is released')
  await page.mouse.up()
  await expectOrder(preview)

  await startProjectDrag(page, ids[5])
  await dragOnto(page, ids[1], 'before')
  assert.deepEqual(await domOrder(), [ids[5], ids[1], ids[2], ids[0], ids[3], ids[4]], 'a second preview also updates the live layout')
  await page.mouse.up()
  await expectOrder([ids[5], ids[1], ids[2], ids[0], ids[3], ids[4]])

  await page.locator(`[data-project-id="${ids[0]}"] .sd-projectcard-head .sd-projectgrip`).focus()
  await page.keyboard.press('ArrowLeft')
  await expectOrder([ids[5], ids[1], ids[0], ids[2], ids[3], ids[4]])
  await page.keyboard.press('ArrowRight')
  await expectOrder([ids[5], ids[1], ids[2], ids[0], ids[3], ids[4]])

  assert.equal(h.board().cards.length, 2, 'reordering keeps every session card')
  assert.equal(h.card('order-0').projectId, ids[0])
  assert.equal(h.card('order-1').projectId, ids[0])
})

test('dragging into the right-edge cancel zone previews the original layout and commits nothing', async t => {
  const h = await createFixture(t, runtime, 'project-reorder-cancel', { viewport: { width: 1200, height: 800 } })
  const projects = await createProjects(h, ['Cancel A', 'Cancel B', 'Cancel C', 'Cancel D'])
  await openOverview(h)
  const { page } = h
  const ids = projects.map(project => project.id)
  const domOrder = () => page.evaluate(() => [...document.querySelectorAll('.sd-projectcard')].map(card => card.dataset.projectId))

  await startProjectDrag(page, ids[0])
  await dragOnto(page, ids[2], 'after')
  assert.deepEqual(await domOrder(), [ids[1], ids[2], ids[0], ids[3]], 'the layout previews the move first')
  const zone = await page.locator('.sd-projectcancel').boundingBox()
  assert.ok(zone, 'the cancel zone appears while reordering')
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 6 })
  await page.waitForFunction(() => document.querySelector('.sd-projectcancel')?.dataset.active === 'true')
  assert.deepEqual(await domOrder(), ids, 'entering the cancel zone restores the committed layout')
  await page.mouse.up()
  await page.waitForTimeout(200)
  assert.deepEqual(h.board().orders.project.ids.filter(id => id !== EMPTY), ids, 'cancelling keeps the stored order')
  assert.deepEqual(await domOrder(), ids)
  assert.equal(await page.locator('.sd-projectcancel').count(), 0)

  await startProjectDrag(page, ids[0])
  await dragOnto(page, ids[3], 'before')
  assert.notDeepEqual(await domOrder(), ids)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  assert.deepEqual(await domOrder(), ids, 'Escape also restores the committed layout')
  await page.mouse.up()
})

test('the create tile matches the row expansion height and keeps its label at the top', async t => {
  const h = await createFixture(t, runtime, 'project-ghost-height', { viewport: { width: 1400, height: 1000 } })
  const projects = await createProjects(h, ['Ghost A', 'Ghost B', 'Ghost C'])
  await openOverview(h)
  const { page } = h
  const measure = () => page.evaluate(() => {
    const ghost = document.querySelector('.sd-ghostcard'), label = ghost.querySelector('span:last-child').getBoundingClientRect(), box = ghost.getBoundingClientRect()
    return { height: box.height, card: document.querySelector('.sd-projectcard').getBoundingClientRect().height, labelTop: label.top - box.top, labelLeft: label.left - box.left }
  })
  const expanded = await measure()
  assert(Math.abs(expanded.height - expanded.card) <= 1, `a lone create tile matches an expanded card: ${JSON.stringify(expanded)}`)
  assert(expanded.labelTop < 24 && expanded.labelLeft < 60, `the create label stays at the top left instead of floating in the middle: ${JSON.stringify(expanded)}`)

  await page.locator('.sd-projectgroup-toggle').click()
  await page.waitForFunction(() => document.querySelector('.sd-ghostcard').getBoundingClientRect().height < 100)
  assert.equal(projects.length, 3)
  await page.locator('.sd-projectgroup-toggle').click()
  await page.waitForFunction(() => document.querySelector('.sd-ghostcard').getBoundingClientRect().height > 300)
})

test('an idle project session jumps immediately from its status menu', async t => {
  const h = await createFixture(t, runtime, 'project-inline-state', { viewport: { width: 1100, height: 800 } })
  const projects = await createProjects(h, ['State project'])
  const project = projects[0]
  await h.mutate({ type: 'create_label', dimension: 'status', name: 'Doing', color: null })
  const state = h.board().statuses[0]
  h.host.set('idle-state', sessionObservation('Idle state session', 'not_started'), false)
  await h.join('idle-state', project.id)
  h.setReplay('idle-state', sessionObservation('Idle state session', 'not_started'))
  await openOverview(h)
  const { page } = h
  await page.getByRole('button', { name: '更改状态：Idle state session', exact: true }).click()
  await page.getByRole('listbox', { name: '更改状态：Idle state session', exact: true }).waitFor()
  await page.getByRole('option', { name: 'Doing', exact: true }).click()
  await page.waitForFunction(name => [...document.querySelectorAll('[data-project-id] .sd-projectrow .sd-status')].some(node => node.textContent.includes(name)), state.name)
  const card = h.card('idle-state')
  assert.deepEqual(card.placement, { kind: 'custom', statusId: state.id })
  assert.match(await page.locator('[data-project-id="' + project.id + '"] .sd-projectrow .sd-status').first().textContent(), /Doing/)
})

test('a reviewable status chip keeps its semantic colour instead of inheriting muted text', async t => {
  const h = await createFixture(t, runtime, 'status-chip-color', { viewport: { width: 1100, height: 800 } })
  const project = (await createProjects(h, ['Color project']))[0]
  h.host.set('review', sessionObservation('Review session', 'completed'), false)
  await h.join('review', project.id)
  await openOverview(h)
  const chip = h.page.locator(`[data-project-id="${project.id}"] .sd-projectrow .sd-state-trigger`).first()
  await chip.waitFor()
  const surface = await chip.evaluate(node => { const style = getComputedStyle(node); return { text: node.textContent, color: style.color, dot: getComputedStyle(node, '::before').backgroundColor, chip: style.getPropertyValue('--sd-chip-color') } })
  assert.match(surface.text, /待确认/)
  assert.equal(surface.chip, '#3d6fb5', 'the chip resolves the semantic info token')
  assert.equal(surface.color, 'rgb(61, 111, 181)', `the trigger resolves the info token, not the row's muted colour: ${JSON.stringify(surface)}`)
  assert.equal(surface.dot, 'rgb(61, 111, 181)', 'the status dot follows the same colour')
})

test('a short status chip hugs its label, left-aligns the name and keeps the caret inside', async t => {
  const h = await createFixture(t, runtime, 'status-chip-width', { viewport: { width: 1100, height: 800 } })
  const project = (await createProjects(h, ['Chip project']))[0]
  h.host.set('short', sessionObservation('Short status', 'completed'), false)
  await h.join('short', project.id)
  await openOverview(h)
  const chip = h.page.locator(`[data-project-id="${project.id}"] .sd-projectrow .sd-state-trigger`).first()
  await chip.waitFor()
  const metrics = await chip.evaluate(node => {
    const box = node.getBoundingClientRect(), name = node.querySelector('.sd-state-name').getBoundingClientRect(), caret = node.querySelector('.sd-statecaret').getBoundingClientRect(), style = getComputedStyle(node)
    return { width: box.width, maxWidth: style.maxWidth, justify: style.justifyContent, nameLeft: name.left - box.left, caretRight: box.right - caret.right, nameText: node.querySelector('.sd-state-name').textContent }
  })
  assert.ok(metrics.width < 100, `a short status must not reserve the old fixed width: ${JSON.stringify(metrics)}`)
  assert.equal(metrics.maxWidth, '128px', 'long labels still clamp at 128px')
  assert.equal(metrics.justify, 'flex-start', 'the chip content is left-aligned')
  assert.ok(metrics.nameLeft <= 12, `the status name starts at the chip's left edge: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.caretRight >= 0 && metrics.caretRight <= 14, `the caret stays at the chip's right side: ${JSON.stringify(metrics)}`)
})

test('the portalled status panel keeps a real surface and stays adjacent to its trigger', async t => {
  const h = await createFixture(t, runtime, 'state-panel-surface', { viewport: { width: 1100, height: 800 } })
  const project = (await createProjects(h, ['Panel project']))[0]
  await h.mutate({ type: 'create_label', dimension: 'status', name: 'Colored', color: '#2f8f63' })
  const state = h.board().statuses[0]
  h.host.set('panel-session', sessionObservation('Panel session', 'not_started'), false)
  await h.join('panel-session', project.id)
  h.setReplay('panel-session', sessionObservation('Panel session', 'not_started'))
  await openOverview(h)
  const { page } = h
  const trigger = page.getByRole('button', { name: '更改状态：Panel session', exact: true })
  await trigger.click()
  const list = page.getByRole('listbox', { name: '更改状态：Panel session', exact: true })
  await list.waitFor()
  const surface = await page.evaluate(() => {
    const trigger = [...document.querySelectorAll('.sd-projectrow .sd-state-trigger')].find(node => node.getAttribute('aria-label') === '更改状态：Panel session')
    const panel = document.querySelector('.sd-statepanel'), option = panel?.querySelector('[role=option]')
    const style = getComputedStyle(panel), box = panel.getBoundingClientRect(), anchor = trigger.getBoundingClientRect()
    return { position: style.position, border: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow, color: style.color,
      top: box.top, bottom: box.bottom, right: box.right, anchorTop: anchor.top, anchorBottom: anchor.bottom, anchorRight: anchor.right,
      boxSizing: style.boxSizing, optionDot: option ? getComputedStyle(option, '::before').backgroundColor : null, rootColor: getComputedStyle(document.querySelector('.sd-root')).color }
  })
  assert.equal(surface.position, 'fixed', 'the panel escapes the clipped project row through fixed positioning')
  assert.equal(surface.border, '1px', `the portalled panel resolves the dashboard border token: ${JSON.stringify(surface)}`)
  assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)', 'the panel paints the surface token instead of staying transparent')
  assert.notEqual(surface.background, 'transparent')
  assert.notEqual(surface.shadow, 'none', 'the panel keeps its elevation')
  assert.equal(surface.boxSizing, 'border-box')
  assert.equal(surface.color, surface.rootColor, 'the panel resolves the same text token as the dashboard shell')
  assert(surface.top >= surface.anchorBottom - 0.5 || surface.bottom <= surface.anchorTop + 0.5, `the panel sits directly below or above its trigger: ${JSON.stringify(surface)}`)
  assert(Math.abs(surface.right - surface.anchorRight) <= 1, `the panel is right-aligned with its trigger: ${JSON.stringify(surface)}`)
  assert.equal(surface.optionDot, 'rgb(47, 143, 99)', 'the option dot inherits the custom status colour through the panel tokens')
  await page.getByRole('option', { name: 'Colored', exact: true }).click()
  await page.waitForFunction(name => [...document.querySelectorAll('[data-project-id] .sd-projectrow .sd-status')].some(node => node.textContent.includes(name)), state.name)
})

test('dragging a project row grip onto another project card moves the session in one step', async t => {
  const h = await createFixture(t, runtime, 'project-row-move', { viewport: { width: 1400, height: 1000 } })
  const [source, destination] = await createProjects(h, ['Move source', 'Move destination'])
  h.host.set('move-me', sessionObservation('Move me', 'completed'), false)
  await h.join('move-me', source.id)
  await openOverview(h)
  const { page } = h
  const row = page.locator('.sd-projectrow').filter({ hasText: 'Move me' })
  const grip = row.locator('.sd-rowgrip')
  await grip.waitFor()
  assert.equal(await grip.getAttribute('draggable'), 'true', 'the grip is a real drag handle')
  assert.equal(await grip.getAttribute('disabled'), null)
  const [box, title] = await Promise.all([grip.boundingBox(), row.locator('.sd-projectrow-title').boundingBox()])
  assert.ok(box && title, 'the grip and title are rendered')
  assert.ok(box.width >= 12 && box.width <= 20, `the grip keeps the compact 14px project-grip width: ${JSON.stringify(box)}`)
  assert.ok(box.height >= 16, `the grip keeps a usable hit area: ${JSON.stringify(box)}`)
  assert.ok(box.x + box.width <= title.x + 1, 'the grip sits before the title instead of covering it')
  // Real Chromium mouse input, not dispatchEvent: drag the grip onto the destination card.
  const card = page.locator(`[data-project-id="${destination.id}"]`)
  await card.scrollIntoViewIfNeeded()
  const to = await card.boundingBox()
  assert.ok(to, 'the destination project card is visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + 16, { steps: 24 })
  // Chromium needs two moves over the same target to dispatch dragover reliably.
  await page.mouse.move(to.x + to.width / 2 + 1, to.y + 16, { steps: 2 })
  await page.waitForFunction(id => document.querySelector(`[data-project-id="${id}"]`)?.dataset.over === 'true', destination.id)
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'dragging never opens the membership dialog')
  const moved = h.nextCall(call => call.method === 'mutate' && call.args.mutation.command.type === 'move_project')
  await page.mouse.up()
  const call = await moved
  assert.equal(call.result.ok, true)
  assert.equal(call.args.mutation.command.projectId, destination.id)
  await page.waitForFunction(id => [...document.querySelectorAll(`[data-project-id="${id}"] .sd-projectrow`)].some(node => node.textContent.includes('Move me')), destination.id)
  assert.equal(h.card('move-me').projectId, destination.id)
  assert.equal(await page.getByRole('dialog', { name: '加入或移动到项目', exact: true }).count(), 0, 'the drop applies in one step without confirmation')
})

test('a status summary chip filters exactly its own project bucket and a second press clears it', async t => {
  const h = await createFixture(t, runtime, 'project-status-filter', { viewport: { width: 1400, height: 900 } })
  const [runA, runB, waiting, unset] = await createProjects(h, ['Filtering run A', 'Filtering run B', 'Filtering waiting', 'Filtering unset'])
  h.host.set('filter-run-a', sessionObservation('Run A', 'running'), false)
  await h.join('filter-run-a', runA.id)
  h.host.set('filter-run-b', sessionObservation('Run B', 'running'), false)
  await h.join('filter-run-b', runB.id)
  h.host.set('filter-waiting', sessionObservation('Waiting work', 'completed'), false)
  await h.join('filter-waiting', waiting.id)
  h.host.set('filter-unset', sessionObservation('Not started', 'not_started'), false)
  await h.join('filter-unset', unset.id)
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  const summary = page.getByRole('group', { name: '筛选', exact: true })
  const chip = summary.locator('[data-status-count="in_progress"]'), waitingChip = summary.locator('[data-status-count="pending_confirm"]'), unsetChip = summary.locator('[data-status-count="unset"]')
  await chip.waitFor()
  const chips = await summary.locator('[data-status-count]').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), pressed: node.getAttribute('aria-pressed'), count: node.querySelector('b')?.textContent, tag: node.tagName, type: node.getAttribute('type'), minHeight: getComputedStyle(node).minHeight, fontSize: getComputedStyle(node).fontSize, radius: getComputedStyle(node).borderRadius, display: getComputedStyle(node).display })))
  assert.deepEqual(chips.map(chip => [chip.label, chip.count]), [
    ['进行中 · 2 个会话；点击筛选包含此状态的项目', '2'],
    ['待确认 · 1 个会话；点击筛选包含此状态的项目', '1'],
    ['未设置状态 · 1 个会话；点击筛选包含此状态的项目', '1'],
  ], JSON.stringify(chips))
  for (const value of chips) {
    assert.equal(value.pressed, 'false', 'no summary filter starts active')
    assert.equal(value.tag, 'BUTTON', 'the chip is a focusable control, not a span')
    assert.equal(value.type, 'button')
    assert.equal(value.minHeight, '0px', 'the chip keeps its compact face instead of the 30px default button height')
    assert.equal(value.fontSize, '10.5px')
    assert.equal(value.radius, '99px')
    assert(['flex', 'inline-flex'].includes(value.display), 'as a flex item the chip blockifies inline-flex, but it stays a chip and not a block button')
  }
  const layout = await page.evaluate(() => {
    const head = document.querySelector('.sd-overviewhead').getBoundingClientRect(), trigger = document.querySelector('.sd-filtertrigger').getBoundingClientRect()
    return {
      headRight: head.right, triggerRight: trigger.right,
      boxes: [...document.querySelectorAll('.sd-filterpanel .sd-statuscount')].map(node => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth })),
    }
  })
  assert(Math.abs(layout.headRight - layout.triggerRight) <= 1, `the selector stays right-aligned in the overview head (${JSON.stringify(layout)})`)
  for (const box of layout.boxes) {
    assert(box.height >= 12 && box.height <= 22, `the button keeps the compact pill height (${JSON.stringify(box)})`)
    assert(box.scrollWidth <= box.width + 1, `the button never clips its status name or count (${JSON.stringify(box)})`)
  }
  const readCards = () => page.evaluate(() => [...document.querySelectorAll('.sd-projectcard')].map(card => ({
    id: card.dataset.projectId, expanded: card.dataset.expanded ?? null,
    rows: [...card.querySelectorAll('.sd-projectrow')].map(row => row.dataset.cardId),
  })))
  const before = await readCards()
  const writes = () => h.calls.filter(call => call.method === 'mutate').length
  const writesBefore = writes()
  assert.equal(before.length, 4)
  assert.equal(await page.locator('.sd-ghostcard').count(), 1)

  await chip.click()
  await page.waitForFunction(() => document.querySelectorAll('.sd-projectcard').length === 2)
  const filtered = await readCards()
  assert.deepEqual(filtered.map(card => card.id).sort(), [runA.id, runB.id].sort(), 'only projects holding that status stay visible')
  assert.deepEqual(filtered.map(card => card.rows), [['filter-run-a'], ['filter-run-b']], 'each card shows only its matching Session')
  for (const card of filtered) assert.equal(card.expanded, before.find(value => value.id === card.id).expanded, 'filtering never collapses or expands a project')
  assert.equal(await page.locator('.sd-projectdrop').count(), 2, 'the surviving projects stay expanded')
  assert.equal(await page.locator('.sd-ghostcard').count(), 0, 'the create-project ghost is hidden while filtering')
  assert.equal(await chip.getAttribute('aria-pressed'), 'true')
  assert.equal(await chip.getAttribute('aria-label'), '进行中 · 2 个会话；已筛选，再次点击取消筛选')
  assert.deepEqual(await summary.locator('[data-status-count] b').allTextContents(), ['2', '1', '1'], 'filtering never changes the global counts')
  assert.equal(writes(), writesBefore, 'a summary filter writes no data')

  // Another status replaces the filter; the same status toggles it off.
  await summary.getByRole('button', { name: '待确认 · 1 个会话；点击筛选包含此状态的项目', exact: true }).click()
  await page.waitForFunction(id => document.querySelectorAll('.sd-projectcard').length === 1 && document.querySelector(`[data-project-id="${id}"]`) !== null, waiting.id)
  const waitingCard = await readCards()
  assert.deepEqual(waitingCard.map(card => [card.id, card.rows]), [[waiting.id, ['filter-waiting']]])
  await waitingChip.click()
  await page.waitForFunction(() => document.querySelectorAll('.sd-projectcard').length === 4)
  assert.equal(await page.locator('.sd-ghostcard').count(), 1, 'clearing restores the create-project entry')
  assert.equal(await chip.getAttribute('aria-pressed'), 'false')

  // The chip is keyboard reachable and Enter applies and clears the filter.
  await chip.focus()
  assert.equal(await chip.evaluate(node => document.activeElement === node), true)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.sd-projectcard').length === 2)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.sd-projectcard').length === 4)

  // The unset bucket is a filter like any other.
  await unsetChip.click()
  await page.waitForFunction(id => document.querySelectorAll('.sd-projectcard').length === 1 && document.querySelector(`[data-project-id="${id}"]`) !== null, unset.id)
  assert.deepEqual((await readCards()).map(card => [card.id, card.rows]), [[unset.id, ['filter-unset']]])
  assert.equal(writes(), writesBefore, 'no summary click ever wrote through the dashboard')
})

test('the filter selector Shift-multi-selects inside a dimension and ANDs dimensions', async t => {
  const h = await createFixture(t, runtime, 'project-filter-multi', { viewport: { width: 1400, height: 900 } })
  const [a, b, c] = await createProjects(h, ['Multi A', 'Multi B', 'Multi C'])
  h.host.set('multi-a', sessionObservation('Multi A work', 'running'), false)
  await h.join('multi-a', a.id)
  h.host.set('multi-b', sessionObservation('Multi B work', 'completed'), false)
  await h.join('multi-b', b.id)
  h.host.set('multi-c', sessionObservation('Multi C work', 'running'), false)
  await h.join('multi-c', c.id)
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  const panel = page.getByRole('group', { name: '筛选', exact: true })
  const run = panel.locator('[data-status-count="in_progress"]'), waiting = panel.locator('[data-status-count="pending_confirm"]')
  const shown = () => page.evaluate(() => [...document.querySelectorAll('.sd-projectcard')].map(card => card.dataset.projectId).sort())
  const waitFor = count => page.waitForFunction(value => document.querySelectorAll('.sd-projectcard').length === value, count)
  const badge = () => page.locator('.sd-filtertrigger [data-filter-count]')

  await run.click()
  await waitFor(2)
  assert.deepEqual(await shown(), [a.id, c.id].sort(), 'one status narrows to its own projects')
  await waiting.click({ modifiers: ['Shift'] })
  await waitFor(3)
  assert.equal(await run.getAttribute('aria-pressed'), 'true')
  assert.equal(await waiting.getAttribute('aria-pressed'), 'true')
  assert.equal(await badge().getAttribute('data-filter-count'), '2', 'the trigger reports how many values are active')
  assert.equal(await badge().textContent(), '2')

  await run.click()
  await waitFor(2)
  assert.equal(await run.getAttribute('aria-pressed'), 'true', 'a plain press replaces the selection in that dimension')
  assert.equal(await waiting.getAttribute('aria-pressed'), 'false')
  assert.equal(await badge().getAttribute('data-filter-count'), '1')

  await run.click({ modifiers: ['Shift'] })
  await waitFor(3)
  assert.equal(await page.locator('.sd-ghostcard').count(), 1, 'Shift-pressing the last value clears the dimension')

  const projectA = panel.locator(`[data-filter-value="__project__:${a.id}"]`), projectB = panel.locator(`[data-filter-value="__project__:${b.id}"]`)
  await projectA.click()
  await waitFor(1)
  assert.deepEqual(await shown(), [a.id])
  await projectB.click({ modifiers: ['Shift'] })
  await waitFor(2)
  assert.deepEqual(await shown(), [a.id, b.id].sort(), 'two values of the project group are ORed')
  assert.equal(await run.getAttribute('aria-pressed'), 'false', 'the status dimension was cleared by the last Shift press')

  await run.click()
  await waitFor(1)
  assert.deepEqual(await shown(), [a.id], 'a second dimension ANDs with the project selection')
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.sd-projectrow')].map(row => row.dataset.cardId).length), 1)
})

test('a terminal card and the status summary share one visible status', async t => {
  const h = await createFixture(t, runtime, 'project-status-terminal', { viewport: { width: 1400, height: 900 } })
  const [running, stopped] = await createProjects(h, ['Terminal running', 'Terminal stopped'])
  h.host.set('terminal-running', sessionObservation('Running work', 'running'), false)
  await h.join('terminal-running', running.id)
  h.host.set('terminal-stopped', sessionObservation('Stopped work', 'interrupted', 'turn:2', { turnEnd: { kind: 'aborted', cause: 'user' } }), false)
  await h.join('terminal-stopped', stopped.id)
  await h.setEntry('projects')
  await h.openDashboard()
  const { page } = h
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  const summary = page.getByRole('group', { name: '筛选', exact: true })
  const stoppedChip = summary.locator('[data-status-count="terminal:stopped"]')
  await stoppedChip.waitFor()
  assert.deepEqual(await summary.locator('[data-status-count]').evaluateAll(nodes => nodes.map(node => [node.querySelector('.sd-state-name')?.textContent, node.querySelector('b')?.textContent])), [
    ['进行中', '1'], ['已停止', '1'],
  ], 'the interrupted card leaves In progress and gets the same label as its card chip')
  assert.match(await page.locator('[data-card-id="terminal-stopped"] .sd-status').textContent(), /已停止/)
  assert.equal(await stoppedChip.getAttribute('aria-label'), '已停止 · 1 个会话；点击筛选包含此状态的项目')
  await stoppedChip.click()
  await page.waitForFunction(id => document.querySelectorAll('.sd-projectcard').length === 1 && document.querySelector(`[data-project-id="${id}"]`) !== null, stopped.id)
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.sd-projectrow')].map(row => row.dataset.cardId)), ['terminal-stopped'])
  await stoppedChip.click()
  await page.waitForFunction(() => document.querySelectorAll('.sd-projectcard').length === 2)
})
