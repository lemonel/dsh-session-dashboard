import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserRuntime, createFixture, openRowMenu, refresh, sessionObservation } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })
async function seeded(t, name) {
  const h = await createFixture(t, runtime, name)
  await h.mutate({ type: 'create_project', name: 'Extension project', color: null, tagIds: [] })
  const project = h.board().projects.find(value => value.name === 'Extension project')
  for (const [id, title] of [['slot-alpha', 'Slot Alpha'], ['slot-beta', 'Slot Beta']]) {
    h.host.set(id, sessionObservation(title), false)
    await h.join(id, project.id)
  }
  // 项目总览 is the only view: a card renders its rows inside the project expansion.
  await h.openDashboard()
  return h
}
const probe = async (page, method, ...args) => page.evaluate(({ method, args }) => window.dashboardFixture.slotProbe[method](...args), { method, args })
const openDetails = async (page, title) => {
  const menu = await openRowMenu(page, title)
  await menu.getByRole('button', { name: '会话详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情', exact: true })
  await details.waitFor()
  return details
}

test('N06 a separate public consumer renders the surviving slots through the native renderer and keeps occurrence-local detail state', async t => {
  const h = await seeded(t, 'extension-occurrences'), { page } = h
  await probe(page, 'mount')
  await page.locator('[data-probe-toolbar]').waitFor()
  await page.locator('[data-probe-summary]').waitFor()
  assert.match(await page.locator('[data-probe-summary]').textContent(), /2/)
  const state = await probe(page, 'snapshot')
  assert.equal(state.registrations, 1)
  assert.equal(state.projections, 1)
  assert.equal(await page.locator('button button').count(), 0)
  // The per-card detail section is the surviving card contribution surface; the
  // row menu is the only way to open it.
  const details = await openDetails(page, 'Slot Alpha')
  await page.locator('[data-probe-detail]').waitFor()
  assert.match(await page.locator('[data-probe-detail]').textContent(), /Slot Alpha/)
  assert.equal(h.board().cards.length, 2)
  assert.equal(h.card('slot-alpha').status, 'pending_review', 'extension opens human UI, never accepts')
  await details.getByRole('button', { name: '关闭会话详情', exact: true }).click()
})

test('N06 an inner contribution failure stays inside the details without taking the overview down', async t => {
  const h = await seeded(t, 'extension-failure'), { page } = h
  await probe(page, 'mount')
  await page.locator('[data-probe-toolbar]').waitFor()
  await probe(page, 'failSession', 'slot-alpha')
  const details = await openDetails(page, 'Slot Alpha')
  await details.getByRole('button', { name: '重试增强', exact: true }).waitFor()
  assert.equal(await details.locator('[data-probe-detail]').count(), 0)
  await details.getByRole('button', { name: '关闭会话详情', exact: true }).click()
  await details.waitFor({ state: 'hidden' })
  // The failed contribution never abdicates the rest of the overview.
  assert.equal(await page.locator('.sd-projectrow').count(), 2)
  assert.equal(await probe(page, 'snapshot').then(value => value.projections), 1)
  await probe(page, 'failSession', null)
  const reopened = await openDetails(page, 'Slot Alpha')
  await page.locator('[data-probe-detail]').waitFor()
  assert.equal(await page.locator('button button').count(), 0)
  // React's development error replay dispatches an ErrorEvent even when this
  // inner boundary recovers. Assert the exact expected fixture error, then leave
  // the harness's global unexpected-error assertion strict for everything else.
  assert.ok(h.pageErrors.length > 0)
  assert.ok(h.pageErrors.every(message => message === 'Intentional isolated contribution failure'))
  h.pageErrors.splice(0)
  await reopened.getByRole('button', { name: '关闭会话详情', exact: true }).click()
})

test('N06 page navigation retains declarations; plugin disposal and core reload reconstruct cleanly', async t => {
  const h = await seeded(t, 'extension-lifecycle'), { page } = h
  await probe(page, 'mount')
  await page.locator('[data-probe-toolbar]').waitFor()
  await page.locator('[data-fixture-nav="plugins"]').click()
  await page.getByRole('heading', { name: 'Fixture Plugins', exact: true }).waitFor()
  assert.equal(await probe(page, 'snapshot').then(value => value.registrations), 1, 'React unmount is not declaration disposal')
  await page.locator('[data-fixture-nav="session-dashboard"]').click()
  await page.locator('[data-probe-toolbar]').waitFor()
  await probe(page, 'dispose')
  await page.locator('[data-probe-toolbar]').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '会话行操作：Slot Alpha', exact: true }).count(), 1, 'core rows survive extension disposal')
  await probe(page, 'mount')
  await page.locator('[data-probe-toolbar]').waitFor()
  await page.evaluate(() => window.dashboardFixture.unloadDashboard())
  assert.equal(await probe(page, 'snapshot').then(value => value.registrations), 0, 'main disposer collapses child registrations')
  await page.evaluate(() => window.dashboardFixture.reloadDashboard())
  await page.getByRole('heading', { name: '会话仪表板', exact: true }).waitFor()
  await page.locator('[data-probe-toolbar]').waitFor()
  assert.equal(await probe(page, 'snapshot').then(value => value.registrations), 1)
  await refresh(h)
  assert.equal(h.board().cards.length, 2)
})
