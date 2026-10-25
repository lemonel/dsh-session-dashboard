import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserRuntime, createFixture, mutation } from '../tools/browser-harness.mjs'

let runtime
before(async () => { runtime = await createBrowserRuntime() })
after(async () => { if (runtime) await runtime.close() })

/** React reads the native colour input through its value tracker, so drive the
 *  real element instead of faking a colour the browser picker itself would produce. */
async function pickNativeColor(locator, value) {
  await locator.evaluate((node, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(node, next)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

test('project and state colours are chosen from a palette instead of typing RGB values', async t => {
  const h = await createFixture(t, runtime, 'color-palette')
  await h.openDashboard()
  const { page } = h

  await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
  const create = page.getByRole('dialog', { name: '新建项目', exact: true })
  await create.getByLabel('项目名称', { exact: true }).fill('Palette project')
  const createPicker = create.getByLabel('项目颜色 调色板', { exact: true })
  assert.equal(await createPicker.getAttribute('type'), 'color', 'the visible control is a native colour picker')
  assert.equal(await create.getByLabel('项目颜色', { exact: true }).inputValue(), '', 'no hex value has to be typed first')
  await create.getByRole('button', { name: '使用颜色 #2f8f63', exact: true }).first().click()
  assert.equal(await create.getByLabel('项目颜色', { exact: true }).inputValue(), '#2f8f63', 'a preset writes the same value the picker would')
  assert.equal(await createPicker.inputValue(), '#2f8f63')
  assert.equal(await create.getByRole('button', { name: '使用颜色 #2f8f63', exact: true }).first().getAttribute('aria-pressed'), 'true')
  await mutation(h, 'create_project', () => create.getByRole('button', { name: '创建项目', exact: true }).click())
  await create.waitFor({ state: 'hidden' })
  assert.equal(h.board().projects.find(project => project.name === 'Palette project').color, '#2f8f63')

  // Project maintenance lives in the card's own menu; the drill-down is gone.
  const projectCard = page.getByRole('article', { name: 'Palette project', exact: true })
  await projectCard.getByRole('button', { name: '项目操作：Palette project', exact: true }).click()
  await projectCard.getByRole('group', { name: '项目操作：Palette project', exact: true }).getByRole('button', { name: '编辑项目', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
  const editPicker = edit.getByLabel('项目颜色 调色板', { exact: true })
  assert.equal(await editPicker.inputValue(), '#2f8f63', 'the saved colour is shown in the picker')

  await pickNativeColor(editPicker, '#c0392b')
  assert.equal(await edit.getByLabel('项目颜色', { exact: true }).inputValue(), '#c0392b', 'the native picker feeds the same field')
  assert.equal(await edit.getByRole('button', { name: '使用颜色 #c0392b', exact: true }).first().getAttribute('aria-pressed'), 'true')
  await mutation(h, 'update_project', () => edit.getByRole('button', { name: '保存项目', exact: true }).click())
  assert.equal(h.board().projects.find(project => project.name === 'Palette project').color, '#c0392b')

  await edit.getByRole('button', { name: '清除颜色', exact: true }).first().click()
  assert.equal(await edit.getByLabel('项目颜色', { exact: true }).inputValue(), '', 'clearing removes the colour instead of keeping a stale hex value')
  await mutation(h, 'update_project', () => edit.getByRole('button', { name: '保存项目', exact: true }).click())
  assert.equal(h.board().projects.find(project => project.name === 'Palette project').color, null)
  await edit.getByRole('button', { name: '关闭编辑项目', exact: true }).click()
  await edit.waitFor({ state: 'hidden' })
})
