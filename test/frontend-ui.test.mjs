import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React from 'react'
import { randomUUID } from 'node:crypto'
import { mutationSchema } from '../lib/shared/commands.js'
import { translateLocale } from '../lib/frontend/i18n.js'
import { emptyBoard, EMPTY, unknownRuntime } from '../lib/shared/model.js'
import { DashboardClient } from '../lib/frontend/client.js'
import { Dashboard } from '../lib/frontend/Dashboard.js'
import { Modal } from '../lib/frontend/Modal.js'
import { ManageDialog } from '../lib/frontend/ManageDialog.js'
import { NATIVE_SIDEBAR_DRAG_TYPE } from '../lib/frontend/native-sidebar.js'
import { PROJECT_DRAG_TYPE } from '../lib/frontend/project-drag.js'
import { SessionRowHead } from '../lib/frontend/RowActions.js'
import { reviewBinding } from '../lib/frontend/view-model.js'
import { OperationToasts } from '../lib/frontend/Toasts.js'
import { previewCenter } from '../lib/frontend/completions.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const active = new Set()
afterEach(() => { cleanup(); for (const client of active) client.stop(); active.clear(); previewCenter.close(); document.body.replaceChildren() })
function fact(extra = {}) { return { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', episodeOrder: 1, endedAt: 200, cursor: 2, sourceLive: true, ...extra } }
function card(id, extra = {}) { return { sessionId: id, membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: id, titleOverride: null, workspace: '/workspace', projectId: null, tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: extra.status ?? 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 1, runtime: fact(), decision: null, joinedAt: 100, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 1, ...extra } }
const label = (id, name = id) => ({ id, name, color: null, createdAt: 1, revision: 0 })
function snapshot(cards = []) { const board = emptyBoard(); board.cards = cards; board.preferences.entry = 'board'; return { board, health: { state: 'ready', message: null, lastSyncAt: 200 } } }
const ok = value => ({ ok: true, value: structuredClone(value) })
function fixture(initial = snapshot()) {
  let stored = structuredClone(initial)
  let failEdit = false, failCreate = false
  const calls = [], navigations = []
  const yes = { available: true, reason: null }, no = { available: false, reason: 'unavailable' }
  const handshake = { apiVersion: 2, serviceId: randomUUID(), scope: { scopeId: randomUUID(), storeId: randomUUID(), recoveryId: randomUUID() }, capabilities: { query: yes, events: yes, completionReplay: yes, evidenceCheck: yes, nativeSidebarFilter: no, isolatedExecution: no, externalDelivery: no, projectWorkflow: yes, businessHistory: yes, sessionInspection: yes, sidebarEntry: no } }
  const api = {
    handshake: async () => ok(handshake),
    history: async query => ok({ sessionId: query.sessionId, membershipId: query.membershipId, records: [], nextAfter: null, retainedFrom: 1, highWatermark: 0, truncated: false, gap: false }),
    snapshot: async () => ok(stored),
    candidates: async () => ok({ items: [], total: 0, nextOffset: null, generation: 'fixture' }),
    navigation: async query => ok({ sessionId: query.sessionId, allowed: true, reason: null, hostArchive: { state: 'active', reason: null } }),
    mutate: async raw => {
      const input = mutationSchema.parse(raw); assert.equal(input.serviceId, handshake.serviceId)
      calls.push(input.command)
      const command = input.command
      if (command.type === 'preferences') {
        if (stored.board.preferences.revision !== command.expectedRevision) return { ok: false, error: { code: 'dashboard/error', message: '偏好版本冲突' } }
        stored.board.preferences = { ...command.value, revision: command.expectedRevision + 1 }
      }
      if (command.type === 'edit_card') {
        if (failEdit) return { ok: false, error: { code: 'dashboard/error', message: '保存失败，版本冲突', details: { reason: 'CONFLICT' } } }
        const target = stored.board.cards.find(card => card.sessionId === command.sessionId)
        if (command.expectedMetadataRevision !== target.metadataRevision) return { ok: false, error: { code: 'dashboard/error', message: '元数据版本冲突' } }
        for (const key of ['tagIds', 'titleOverride', 'progress']) target[key] = structuredClone(command[key])
        target.metadataRevision++
      }
      if (command.type === 'create_label') {
        if (failCreate) return { ok: false, error: { code: 'dashboard/error', message: '创建标签失败', details: { reason: 'STORAGE' } } }
        const values = command.dimension === 'status' ? stored.board.statuses : stored.board.tags
        const created = command.dimension === 'tag' ? { ...label(`${command.dimension}-${values.length + 1}`, command.name.trim()), groupId: command.groupId ?? null } : label(`${command.dimension}-${values.length + 1}`, command.name.trim())
        values.push(created)
        const ids = stored.board.orders[command.dimension].ids
        ids.splice(ids.at(-1) === EMPTY ? ids.length - 1 : ids.length, 0, created.id)
        stored.board.orders[command.dimension].revision++
      }
      if (command.type === 'update_label') {
        const values = command.dimension === 'status' ? stored.board.statuses : stored.board.tags
        const target = values.find(row => row.id === command.id)
        if (target.revision !== command.expectedRevision) return { ok: false, error: { code: 'dashboard/error', message: '选项版本冲突' } }
        Object.assign(target, { name: command.name.trim(), color: command.color, revision: target.revision + 1 })
        if (command.dimension === 'tag') target.groupId = command.groupId ?? null
      }
      if (command.type === 'delete_label') {
        if (command.dimension === 'status') {
          for (const target of stored.board.cards) if (target.placement.kind === 'custom' && target.placement.statusId === command.id) { target.placement = { kind: 'unset' }; target.workflowRevision++ }
          stored.board.statuses = stored.board.statuses.filter(row => row.id !== command.id)
        } else stored.board.tags = stored.board.tags.filter(row => row.id !== command.id)
        stored.board.orders[command.dimension].ids = stored.board.orders[command.dimension].ids.filter(id => id !== command.id)
        stored.board.orders[command.dimension].revision++
      }
      if (command.type === 'review') {
        const target = stored.board.cards.find(card => card.sessionId === command.sessionId)
        if (target.membershipId !== command.membershipId || target.metadataRevision !== command.expectedMetadataRevision || target.workflowRevision !== command.expectedWorkflowRevision || target.lifecycleRevision !== command.expectedLifecycleRevision || target.runtime.episodeId !== command.episodeId) return { ok: false, error: { code: 'dashboard/error', message: '轮次过期' } }
        target.status = command.action === 'accept' ? 'accepted' : 'in_progress'; target.placement = { kind: 'builtin', status: target.status }; target.lifecycleRevision++; target.workflowRevision++
        target.decision = { kind: command.action === 'accept' ? 'accepted' : 'returned', episodeId: target.runtime.episodeId, at: 300 }; target.reviewAt = null; target.acceptedAt = command.action === 'accept' ? 300 : null
      }
      if (command.type === 'archive') { const target = stored.board.cards.find(card => card.sessionId === command.sessionId); target.archivedAt = command.archived ? 300 : null; target.metadataRevision++ }
      if (command.type === 'remove_card') stored.board.cards = stored.board.cards.filter(card => card.sessionId !== command.sessionId)
      if (command.type === 'delete_project') {
        stored.board.projects = stored.board.projects.filter(project => project.id !== command.projectId)
        stored.board.orders.project.ids = stored.board.orders.project.ids.filter(id => id !== command.projectId)
        stored.board.orders.project.revision++
        for (const target of stored.board.cards) if (target.projectId === command.projectId) { target.projectId = null; target.metadataRevision++ }
      }
      if (command.type === 'reorder') { stored.board.orders[command.dimension].ids = [...command.ids]; stored.board.orders[command.dimension].revision++ }
      stored.board.revision++
      return ok(stored)
    },
  }
  const client = new DashboardClient(api, 60000); active.add(client)
  return { client, api, calls, navigations, get stored() { return stored }, set stored(value) { stored = value }, set failEdit(value) { failEdit = value }, set failCreate(value) { failCreate = value }, render: (extra = {}) => render(React.createElement(Dashboard, { client, openSession: id => navigations.push(id), ...extra })) }
}
const project = (id, name = id) => ({ id, name, color: null, createdAt: 1, revision: 0, tagIds: [] })
function projectSnapshot() { const initial = snapshot(); initial.board.preferences.entry = 'projects'; initial.board.projects = [project('p1', 'Project one')]; initial.board.orders.project.ids = ['p1', EMPTY]; return initial }
async function openProjectActions(name = 'Project one') { const trigger = await screen.findByRole('button', { name: `项目操作：${name}` }); fireEvent.click(trigger); return screen.findByRole('group', { name: `项目操作：${name}` }) }

/** 项目总览 is the only view: one project card owns every card in these tests,
 *  and it starts expanded, so the rows live in its `.sd-projectdrop-list`. */
function boardSnapshot(cards = [], name = '项目一', id = 'bp') {
  const initial = snapshot(cards)
  initial.board.projects = [project(id, name)]
  initial.board.orders.project.ids = [id, EMPTY]
  for (const value of cards) value.projectId = id
  return initial
}
/** Every project starts expanded; expand it explicitly if a test collapsed it. */
async function openBoard(name = '项目一') {
  const tile = await screen.findByRole('article', { name })
  const toggle = tile.querySelector('.sd-projecttoggle')
  if (toggle?.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  await within(tile).findByRole('region', { name: new RegExp(`^${name} · `) })
  return screen.getByRole('main')
}
/** 未归属 and 已归档 sessions live in collapsed sections at the bottom of 项目总览. */
async function expandBucket(bucket) {
  const toggle = await screen.findByRole('button', { name: bucket === 'archive' ? /已归档会话/ : /未归属会话/ })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  return document.querySelector(`.sd-bucket[data-bucket="${bucket}"]`)
}
async function openRowMenu(title, bucket = 'unassigned') {
  await expandBucket(bucket)
  fireEvent.click(await screen.findByRole('button', { name: `会话行操作：${title}` }))
  return screen.findByRole('group', { name: `会话行操作：${title}` })
}

test('the row agent facet counts the host fact and lists child titles from the client catalogue', async () => {
  const f = fixture(boardSnapshot([card('Alpha', { runtime: fact({ activeAgents: 2 }) })]))
  const rows = [
    { id: 'Alpha', displayTitle: 'Alpha', running: true },
    { id: 'child-a', displayTitle: '子 Agent 甲', running: true, parentId: 'Alpha' },
    { id: 'child-b', displayTitle: '子 Agent 乙', running: false, parentId: 'Alpha' },
  ]
  const sessionList = { getSnapshot: () => ({ ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} }), subscribe: () => () => {} }
  f.render({ sessionList }); await openBoard()
  const chip = await screen.findByRole('button', { name: '该会话下仍在运行的子 Agent' })
  assert.match(chip.textContent, /2/, 'the chip reports the Host count without reading the catalogue')
  fireEvent.click(chip)
  const panel = await screen.findByRole('group', { name: '该会话下仍在运行的子 Agent' })
  const titles = [...panel.querySelectorAll('.sd-facet-title')].map(node => node.textContent)
  assert.deepEqual(titles.slice(0, 1), ['子 Agent 甲'], 'only the running child is listed as running work')
  assert.equal(panel.querySelectorAll('.sd-facet-row[data-state=running]').length, 1)
  assert.match(panel.textContent, /历史子 Agent/, 'the idle child is folded into the history line instead of posing as running work')
})

/** The drawer opens from the row menu only: the row title owns the preview. */
const open = async id => {
  await openBoard()
  fireEvent.click(await screen.findByRole('button', { name: `会话行操作：${id}` }))
  fireEvent.click(within(await screen.findByRole('group', { name: `会话行操作：${id}` })).getByRole('button', { name: '会话详情' }))
  return screen.findByRole('dialog', { name: '会话详情' })
}
const refresh = async fixture => { await act(async () => { await fixture.client.refresh() }) }

test('draft survives polling, metadata conflict and a failed save; close guard is explicit', async () => {
  const f = fixture(boardSnapshot([card('Alpha')]))
  f.render(); await open('Alpha')
  fireEvent.change(screen.getByLabelText('一句话进展'), { target: { value: '本地草稿，不得被轮询覆盖' } })
  f.stored.board.cards[0].runtime = fact({ phase: 'running', episodeId: 'round-2', episodeOrder: 2 }); f.stored.board.cards[0].lifecycleRevision = 2; f.stored.board.cards[0].status = 'in_progress'; f.stored.board.revision++
  await refresh(f)
  assert.equal(screen.getByLabelText('一句话进展').value, '本地草稿，不得被轮询覆盖')
  assert.equal(screen.queryByRole('dialog', { name: '有未保存的修改' }), null, 'polling does not discard or replace the open editor')
  assert.equal(screen.getByLabelText('一句话进展').value, '本地草稿，不得被轮询覆盖')
  f.failEdit = true
  fireEvent.click(screen.getByRole('button', { name: '保存字段' }))
  await screen.findByText(/数据已被其他操作修改/)
  assert.equal(screen.getByLabelText('一句话进展').value, '本地草稿，不得被轮询覆盖')
  fireEvent.click(screen.getByRole('button', { name: '关闭会话详情' }))
  assert.ok(screen.getByRole('dialog', { name: '有未保存的修改' }))
  assert.equal(f.calls.filter(command => command.type === 'edit_card').length, 1)
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  f.stored.board.cards[0].metadataRevision = 4; f.stored.board.cards[0].progress = '其他窗口内容'; f.stored.board.revision++
  await refresh(f)
  assert.ok(screen.getByText(/其他窗口已修改该卡片/))
  assert.equal(screen.getByRole('button', { name: '保存字段' }).disabled, true)
  assert.equal(screen.getByLabelText('一句话进展').value, '本地草稿，不得被轮询覆盖')
})

test('acceptance follows the run the details show and a newer run requires an explicit re-check', async () => {
  const f = fixture(boardSnapshot([card('Review')]))
  f.render(); const details = await open('Review')
  assert.match(details.textContent, /round-1/)
  f.stored.board.cards[0].runtime = fact({ episodeId: 'round-2', episodeOrder: 2 }); f.stored.board.cards[0].lifecycleRevision = 3; f.stored.board.revision++
  await refresh(f)
  // The open details stay bound to the run the human looked at: the stale
  // confirmation notice appears instead of adopting the newer run silently.
  assert.ok(within(details).getByText(/旧确认已失效/))
  assert.equal(f.calls.some(command => command.type === 'review'), false, 'a stale details binding never issues a review')
  fireEvent.click(within(details).getByRole('button', { name: '我已重新核对当前轮次' }))
  assert.equal(within(details).queryByRole('button', { name: '我已重新核对当前轮次' }), null)
  assert.match(details.textContent, /round-2/)
  fireEvent.click(within(details).getByRole('button', { name: '关闭会话详情' }))
  // Acceptance is the row's own state chip now; the explicit re-check above is
  // what re-arms it against the run the human inspected.
  assert.equal(screen.queryByRole('dialog', { name: '会话详情' }), null)
  fireEvent.click(await screen.findByRole('button', { name: '更改状态：Review' }))
  const listbox = await screen.findByRole('listbox', { name: '更改状态：Review' })
  fireEvent.click(within(listbox).getByRole('option', { name: '已验收' }))
  await waitFor(() => assert.equal(f.stored.board.cards[0].status, 'accepted'))
  const command = f.calls.find(command => command.type === 'review')
  assert.equal(command.episodeId, 'round-2'); assert.equal(command.expectedLifecycleRevision, 3); assert.equal(command.confirmed, true)
})
test('a different unavailable card degrades global health but does not block a healthy live card review', async () => {
  const initial = boardSnapshot([card('Healthy'), card('Missing', { runtime: fact({ sync: 'missing', sourceLive: false }) })])
  initial.health = { state: 'degraded', message: 'Missing: 会话不可用', lastSyncAt: 200 }
  const f = fixture(initial); f.render()
  const chip = await screen.findByRole('button', { name: '更改状态：Healthy' })
  assert.equal(chip.disabled, false)
  fireEvent.click(chip)
  const listbox = await screen.findByRole('listbox', { name: '更改状态：Healthy' })
  fireEvent.click(within(listbox).getByRole('option', { name: '已验收' }))
  await waitFor(() => assert.equal(f.stored.board.cards.find(value => value.sessionId === 'Healthy').status, 'accepted'))
  assert.equal(f.calls.some(command => command.type === 'review'), true)
})
test('the close guard protects a dirty draft and the draft is retained across a native remount', async () => {
  const f = fixture(boardSnapshot([card('Navigate')]))
  const mounted = f.render(); await open('Navigate')
  fireEvent.change(screen.getByLabelText('一句话进展'), { target: { value: '保存后才能离开' } })
  fireEvent.click(screen.getByRole('button', { name: '关闭会话详情' }))
  const guard = screen.getByRole('dialog', { name: '有未保存的修改' })
  assert.equal(within(guard).getByRole('button', { name: '保存并继续' }).disabled, false)
  fireEvent.click(within(guard).getByRole('button', { name: '保存并继续' }))
  await waitFor(() => assert.equal(f.stored.board.cards[0].progress, '保存后才能离开'))
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '会话详情' }), null))
  await open('Navigate')
  fireEvent.change(screen.getByLabelText('一句话进展'), { target: { value: '宿主外部导航时也保留此草稿' } })
  mounted.unmount()
  f.render(); await screen.findByRole('dialog', { name: '会话详情' })
  assert.equal(screen.getByLabelText('一句话进展').value, '宿主外部导航时也保留此草稿')
  assert.equal(f.calls.filter(command => command.type === 'edit_card').length, 1, 'only the explicit save wrote the fields')
})
test('project deletion lives in the card menu beside editing, behind explicit confirmation and keeps sessions', async () => {
  const initial = snapshot([card('Alpha', { projectId: 'p1' })])
  initial.board.projects = [{ ...label('p1', '项目一'), tagIds: [] }]
  initial.board.orders.project.ids = ['p1', EMPTY]
  initial.board.preferences.entry = 'projects'
  const f = fixture(initial)
  f.render()
  const overviewCard = await screen.findByRole('article', { name: '项目一' })
  assert.equal(screen.queryByRole('button', { name: '添加会话' }), null, 'adding is no longer a persistent title-bar button')
  assert.equal(screen.getAllByRole('button', { name: '新建项目' }).length, 1, 'the dashed grid tile is the only create-project entry point')
  fireEvent.click(within(overviewCard).getByRole('button', { name: '项目操作：项目一' }))
  assert.ok(within(overviewCard).getByRole('button', { name: '编辑项目' }))
  assert.equal(within(overviewCard).queryByRole('button', { name: '进入项目：项目一' }), null, 'the board entry is not repeated in the menu')
  assert.equal(within(overviewCard).queryByRole('button', { name: '新建会话' }), null, 'without a host creation path no session entry is offered')
  fireEvent.click(within(overviewCard).getByRole('button', { name: '删除项目' }))
  const dialog = await screen.findByRole('dialog', { name: '删除项目“项目一”？' })
  assert.match(dialog.textContent, /会话会变为未归属/)
  assert.equal(f.calls.some(command => command.type === 'delete_project'), false, 'nothing is deleted before explicit confirmation')
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除项目' }))
  await waitFor(() => assert.equal(f.calls.some(command => command.type === 'delete_project'), true))
  await waitFor(() => assert.equal(screen.queryByRole('article', { name: '项目一' }), null))
  assert.equal(f.stored.board.cards.length, 1, 'the session itself is not deleted')
  assert.equal(f.stored.board.cards[0].projectId, null, 'the session becomes unassigned')
  assert.ok(await screen.findByText('项目已删除；其中的会话已变为未归属，聊天未删除。'))
})

test('D03 live blocked, paused, disarmed and cancellation explanations appear in the details with next steps', async () => {
  const cases = [
    ['Blocked', 'suspended', '目标已阻塞，等待人工处理或恢复'],
    ['Paused', 'suspended', '目标已暂停，等待恢复'],
    ['Disarmed', 'suspended', '活动目标在当前进程未获续跑授权，需人工恢复'],
    ['Cancelled', 'interrupted', '活动目标已取消，尚无后续完整正常执行'],
    ['Input', 'waiting_input', '宿主正在等待用户输入'],
    ['Approval', 'waiting_approval', '宿主正在等待用户授权'],
  ]
  const f = fixture(boardSnapshot(cases.map(([id, phase, explanation]) => card(id, { status: 'in_progress', runtime: fact({ phase, explanation }) }))))
  f.render(); await openBoard()
  for (const [id, phase, explanation] of cases) {
    const details = await open(id)
    const guidance = details.querySelector('[aria-label="运行原因与下一步"]')
    assert.ok(guidance, 'the details carry the runtime guidance block')
    assert.ok(within(guidance).getByText(explanation), 'the details preserve the live runtime reason')
    assert.match(guidance.textContent, phase === 'suspended' ? /进入会话.*不会自动恢复/ : phase === 'interrupted' ? /中断或取消/ : phase === 'waiting_input' ? /不提供原地答复/ : /不能直接批准/)
    fireEvent.click(within(details).getByRole('button', { name: '关闭会话详情' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '会话详情' }), null))
  }
  assert.deepEqual(f.calls.filter(command => command.type !== 'preferences'), [])
})
test('D05 an empty custom status list is created through management and returns to the same overview without assigning cards', async () => {
  const f = fixture(boardSnapshot([card('Unset status', { status: 'in_progress', placement: { kind: 'unset' } })]))
  f.render(); await openBoard()
  assert.equal(f.stored.board.statuses.length, 0)
  const overviewScroll = screen.getByRole('main')
  overviewScroll.scrollLeft = 90; overviewScroll.scrollTop = 240; fireEvent.scroll(overviewScroll)
  assert.equal(screen.queryByRole('button', { name: '分类与排列', exact: true }), null, 'the manage entry lives behind the more-actions menu, not in the toolbar')
  const moreTrigger = screen.getByRole('button', { name: '更多操作', exact: true }); moreTrigger.focus(); fireEvent.click(moreTrigger)
  assert.equal(moreTrigger.getAttribute('aria-expanded'), 'true')
  fireEvent.click(screen.getByRole('button', { name: '分类与排列', exact: true }))
  assert.equal(screen.queryByRole('button', { name: '分类与排列', exact: true }), null, 'selecting the menu item closes the menu it was opened from')
  const manage = screen.getByRole('dialog', { name: '分类与展示排列' })
  assert.equal(within(manage).getByRole('button', { name: '状态', exact: true }).getAttribute('aria-pressed'), 'true', 'the status segment is the default category view')
  assert.equal(within(manage).queryByRole('region', { name: '普通标签' }), null, 'priorities no longer have their own management section')
  fireEvent.change(within(manage).getByLabelText('状态名称'), { target: { value: '我的关注组' } })
  fireEvent.click(within(manage).getByRole('button', { name: '新建状态' }))
  await within(manage).findByText('我的关注组', { exact: false })
  overviewScroll.scrollLeft = 0; overviewScroll.scrollTop = 0 // Simulate modal focus / layout moving the underlying overview.
  fireEvent.click(within(manage).getByRole('button', { name: '关闭分类与展示排列' }))
  assert.equal(document.activeElement, moreTrigger, 'closing the dialog returns focus to the more-actions trigger; the menu item it was opened from no longer exists')
  assert.equal(overviewScroll.scrollLeft, 90); assert.equal(overviewScroll.scrollTop, 240)
  assert.equal(f.stored.board.statuses.length, 1)
  assert.deepEqual(f.stored.board.cards[0].placement, { kind: 'unset' }, 'creating a status never reassigns existing cards')
  // The overview has no columns to add: the row keeps its own read-only chip and
  // no assignment command is issued by creating the status.
  const row = document.querySelector('.sd-projectrow[data-card-id="Unset status"]')
  assert.ok(row, 'the session row is still listed under its project')
  assert.match(row.querySelector('.sd-status').textContent, /未设置状态/)
  assert.equal(f.calls.some(command => command.type === 'choose_state'), false)
})
const ws = (workspaceId, title = workspaceId, path = `/ws/${workspaceId}`) => ({ workspaceId, title, path })
const sessionRow = (id, extra = {}) => ({ id, displayTitle: `Session ${id}`, cwd: `/cwd/${id}`, blank: true, running: false, ...extra })
function fakeSessionList(rows) {
  const state = values => ({ ids: values.map(row => row.id), byId: Object.fromEntries(values.map(row => [row.id, row])) })
  let values = [...rows]
  let snapshot = state(values)
  const listeners = new Set()
  const publish = next => { values = [...next]; snapshot = state(values); for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    update(next) { publish(next) },
    /** Project one Client Session Controller event the way the controller does:
     *  `api-session/added` inserts a new row, `status`/`activity` republish the
     *  existing row. Only the list subscription delivers it; no host poll is involved. */
    emit(kind, row) {
      publish(kind === 'added' && !values.some(current => current.id === row.id) ? [...values, row] : values.map(current => current.id === row.id ? row : current))
    },
    get listenerCount() { return listeners.size },
  }
}
async function openOfficialCreate() {
  const menu = await openProjectActions()
  fireEvent.click(within(menu).getByRole('button', { name: '新建会话' }))
  return screen.findByRole('dialog', { name: '在官方界面新建会话' })
}

test('official creation embeds the host UI and only confirms blank -> started', async () => {
  const f = fixture(projectSnapshot())
  const joins = []
  const list = fakeSessionList([sessionRow('known', { blank: false })])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async (...args) => { joins.push(args); return { status: 'applied' } } })
  const overlay = await openOfficialCreate()
  assert.ok(within(overlay).getByTitle('官方 DSH 新会话界面'))
  assert.ok(within(overlay).getByText('等待你在官方界面发送第一条消息…'))
  await act(async () => list.update([sessionRow('known', { blank: false }), sessionRow('blank-new')]))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null, 'a new blank session is ignored')
  await act(async () => list.update([sessionRow('known', { blank: false }), sessionRow('blank-new', { blank: false })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  assert.match(overlay.textContent, /Session blank-new/)
  assert.match(overlay.textContent, /目录：\/cwd\/blank-new/)
  fireEvent.click(within(overlay).getByRole('button', { name: '不加入' }))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null)
  assert.deepEqual(joins, [], 'dismissing never joins')
  await act(async () => list.update([sessionRow('known', { blank: false }), sessionRow('blank-new', { blank: false })]))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null, 'the same session is never confirmed twice')
  await act(async () => list.update([sessionRow('known', { blank: false }), sessionRow('blank-new', { blank: false }), sessionRow('started', { blank: false })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  fireEvent.click(within(overlay).getByRole('button', { name: '加入项目' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '在官方界面新建会话' }), null))
  assert.deepEqual(joins, [[{ kind: 'sidebar', sessionId: 'started', displayTitle: 'Session started' }, 'p1']])
})

test('official creation ignores baseline sessions and a session that appears already started is immediate', async () => {
  const f = fixture(projectSnapshot())
  const joins = []
  const list = fakeSessionList([sessionRow('baseline', { blank: false })])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async (...args) => { joins.push(args); return { status: 'applied' } } })
  const overlay = await openOfficialCreate()
  await act(async () => list.update([sessionRow('baseline', { blank: false, displayTitle: 'Baseline renamed' })]))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null, 'a session that was already started never prompts')
  await act(async () => list.update([sessionRow('baseline', { blank: false }), sessionRow('subagent', { blank: false, origin: 'subagent' })]))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null, 'subagent rows never prompt')
  await act(async () => list.update([sessionRow('baseline', { blank: false }), sessionRow('fresh', { blank: false })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  assert.match(overlay.textContent, /Session fresh/)
})

test('official creation warns before moving a card from another project and offers no join for the same project', async () => {
  const initial = projectSnapshot()
  initial.board.projects = [project('p1', 'Project one'), project('p2', 'Project two')]
  initial.board.orders.project.ids = ['p1', 'p2', EMPTY]
  initial.board.cards = [card('other', { projectId: 'p2' }), card('same', { projectId: 'p1' })]
  const f = fixture(initial)
  const list = fakeSessionList([sessionRow('other'), sessionRow('same')])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
  const overlay = await openOfficialCreate()
  await act(async () => list.update([sessionRow('other', { blank: false }), sessionRow('same', { blank: true })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  assert.match(overlay.textContent, /当前在项目 Project two；确认加入 Project one 会移动它。/)
  assert.ok(within(overlay).getByRole('button', { name: '移动到该项目' }))
  fireEvent.click(within(overlay).getByRole('button', { name: '不加入' }))
  await act(async () => list.update([sessionRow('other', { blank: false }), sessionRow('same', { blank: false })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  assert.match(overlay.textContent, /该会话已在目标项目中。/)
  assert.equal(within(overlay).queryByRole('button', { name: '加入项目' }), null)
  assert.equal(within(overlay).queryByRole('button', { name: '移动到该项目' }), null)
})

test('closing official creation destroys the frame and stops watching', async () => {
  const intervals = new Map(), cleared = []
  const set = window.setInterval, clear = window.clearInterval
  window.setInterval = (fn, ms) => { const handle = set(fn, ms); intervals.set(handle, ms); return handle }
  window.clearInterval = handle => { cleared.push(handle); clear(handle) }
  try {
    const f = fixture(projectSnapshot())
    const list = fakeSessionList([])
    f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
    const overlay = await openOfficialCreate()
    assert.equal(list.listenerCount, 1)
    assert.equal(intervals.size, 1)
    fireEvent.click(within(overlay).getByRole('button', { name: '关闭创建浮层' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '在官方界面新建会话' }), null))
    assert.equal(list.listenerCount, 0)
    assert.equal(cleared.length, 1)
    assert.equal(screen.queryByTitle('官方 DSH 新会话界面'), null)
  } finally { window.setInterval = set; window.clearInterval = clear }
})

test('official creation confirms from a list subscription update and never refreshes the whole list', async () => {
  const f = fixture(projectSnapshot())
  const joins = []
  let refreshes = 0
  const list = fakeSessionList([sessionRow('known', { blank: false })])
  f.render({
    sessionList: list,
    creationFrameUrl: 'about:blank',
    // The removed chain would have called this once per second while open; the
    // prop no longer exists on Dashboard, so the overlay cannot reach it.
    refreshSessionList: () => { refreshes += 1; return Promise.resolve() },
    requestJoin: async (...args) => { joins.push(args); return { status: 'applied' } },
  })
  const overlay = await openOfficialCreate()
  assert.ok(within(overlay).getByText('等待你在官方界面发送第一条消息…'))
  // Waiting past one fallback scan proves the timer only re-reads the cached
  // snapshot: a Session that was never published stays invisible, and no global
  // refresh happens. Detection must come from the subscription below.
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null)
  assert.equal(refreshes, 0, 'opening the overlay never refreshes the whole session list')
  await act(async () => list.update([sessionRow('known', { blank: false }), sessionRow('created', { blank: false })]))
  await within(overlay).findByRole('heading', { name: '检测到会话已开始' })
  assert.match(overlay.textContent, /Session created/)
  assert.match(overlay.textContent, /目录：\/cwd\/created/)
  assert.equal(refreshes, 0, 'a subscription update confirms without a global refresh')
  assert.deepEqual(joins, [], 'detection never joins on its own')
  fireEvent.click(within(overlay).getByRole('button', { name: '加入项目' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '在官方界面新建会话' }), null))
  assert.deepEqual(joins, [[{ kind: 'sidebar', sessionId: 'created', displayTitle: 'Session created' }, 'p1']], 'the existing join path adds it to the target project')
})

test('official creation reuses the floating native window shell instead of a full-screen frame', async () => {
  const f = fixture(projectSnapshot())
  const list = fakeSessionList([sessionRow('known', { blank: false })])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
  const overlay = await openOfficialCreate()
  const wrap = overlay.querySelector('.sd-native-page-wrap')
  assert.ok(wrap, 'the official frame uses the same native page shell as the preview')
  const frame = wrap.querySelector('iframe.sd-native-page')
  assert.ok(frame, 'the shared shell carries the native page class the preview sizes')
  assert.equal(frame.getAttribute('title'), '官方 DSH 新会话界面')
  assert.equal(overlay.querySelector('.sd-official-frame'), null, 'no separate full-screen iframe remains')
  const foot = overlay.querySelector('.sd-official-foot')
  assert.ok(foot, 'the confirmation footer is kept')
  assert.equal(wrap.contains(foot), false, 'the footer sits outside the frame region instead of covering it')
  assert.ok(foot.textContent.includes('等待你在官方界面发送第一条消息…'))
  assert.ok(within(overlay).getByRole('button', { name: '关闭创建浮层' }))
})

test('opening the official creation UI closes an open preview so only one native window is used', async () => {
  const f = fixture(projectSnapshot())
  const list = fakeSessionList([])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
  await act(async () => previewCenter.open({ sessionId: 'some-session', title: 'Some session' }))
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'some-session')
  await openOfficialCreate()
  assert.equal(previewCenter.getSnapshot(), null, 'the preview is closed before the creation window opens')
})

test('official creation confirms from api-session added, status and activity publications', async () => {
  const f = fixture(projectSnapshot())
  const list = fakeSessionList([sessionRow('known', { blank: false })])
  f.render({ sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
  const overlay = await openOfficialCreate()
  assert.equal(list.listenerCount, 1, 'the overlay watches the controller projection by subscription')
  // api-session/added inserts the Session while it is still blank: baseline it
  // but never prompt. No timer is waited on anywhere in this test.
  await act(async () => list.emit('added', sessionRow('status-started', { blank: true })))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null, 'a newly added blank Session is ignored')
  // The first message arrives as api-session/status: the row leaves blank and the
  // subscription scan sees it immediately, not on the one-second fallback.
  await act(async () => list.emit('status', sessionRow('status-started', { blank: false, running: true })))
  assert.ok(within(overlay).getByRole('heading', { name: '检测到会话已开始' }), 'a status event is scanned on its own tick')
  assert.match(overlay.textContent, /Session status-started/)
  fireEvent.click(within(overlay).getByRole('button', { name: '不加入' }))
  // api-session/activity republishes the same projection and must work the same way.
  await act(async () => list.emit('added', sessionRow('activity-started', { blank: true })))
  assert.equal(within(overlay).queryByRole('heading', { name: '检测到会话已开始' }), null)
  await act(async () => list.emit('activity', sessionRow('activity-started', { blank: false, running: true })))
  assert.ok(within(overlay).getByRole('heading', { name: '检测到会话已开始' }), 'an activity event is scanned on its own tick')
  assert.match(overlay.textContent, /Session activity-started/)
})

test('direct creation is the primary path even when the official overlay is available', async () => {
  const f = fixture(projectSnapshot())
  const list = fakeSessionList([sessionRow('known', { blank: false })])
  f.render({ createSession: async () => 'new-session', listWorkspaces: async () => [ws('ws-1')], sessionList: list, creationFrameUrl: 'about:blank', requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  assert.ok(within(dialog).getByRole('radio', { name: 'ws-1' }))
  assert.equal(screen.queryByRole('dialog', { name: '在官方界面新建会话' }), null, 'the direct picker wins when the host supports it')
})

test('the workspace picker can register a new workspace from the host folder chooser', async () => {
  const f = fixture(projectSnapshot())
  const added = [], created = []
  f.render({ listWorkspaces: async () => [], pickDirectory: async () => '/new/workspace', createWorkspace: async path => { added.push(path); return ws('ws-new', 'New workspace', '/new/workspace') }, createSession: async id => { created.push(id); return 'new-session' }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  await within(dialog).findByText('还没有工作区；请先在左侧工作区列表添加文件夹')
  fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹并添加' }))
  const radio = await within(dialog).findByRole('radio', { name: 'New workspace' })
  assert.equal(radio.checked, true, 'the newly registered workspace is selected')
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建并加入项目。')
  assert.deepEqual(added, ['/new/workspace'])
  assert.deepEqual(created, ['ws-new'])
})

test('direct creation reuses an untracked blank session in the same workspace', async () => {
  const f = fixture(projectSnapshot())
  const created = [], joined = []
  const list = fakeSessionList([sessionRow('blank-1', { cwd: '/ws/ws-1' })])
  f.render({ listWorkspaces: async () => [ws('ws-1', 'Alpha', '/ws/ws-1')], sessionList: list, createSession: async id => { created.push(id); return 'new-session' }, requestJoin: async (source, projectId) => { joined.push([source, projectId]); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('已复用此工作区现有的未开始会话。')
  assert.deepEqual(created, [], 'no second blank is created')
  assert.deepEqual(joined, [[{ kind: 'sidebar', sessionId: 'blank-1', displayTitle: '' }, 'p1']])
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'blank-1')
})

test('a blank session already tracked in another project is moved instead of duplicated', async () => {
  const initial = projectSnapshot()
  initial.board.projects.push(project('p2', 'Project two'))
  initial.board.orders.project.ids = ['p1', 'p2', EMPTY]
  initial.board.cards = [card('blank-other', { projectId: 'p2' })]
  const f = fixture(initial)
  const created = [], joined = []
  const list = fakeSessionList([sessionRow('blank-other', { cwd: '/ws/ws-1' })])
  f.render({ listWorkspaces: async () => [ws('ws-1', 'Alpha', '/ws/ws-1')], sessionList: list, createSession: async id => { created.push(id); return 'new-session' }, requestJoin: async (source, projectId) => { joined.push([source, projectId]); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText(/此工作区已有未开始会话「blank-other」，属于项目 Project two；将直接移动到当前项目/)
  assert.deepEqual(created, [], 'the existing blank is reused')
  assert.deepEqual(joined, [[{ kind: 'sidebar', sessionId: 'blank-other', displayTitle: '' }, 'p1']])
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'blank-other')
})

test('new session exposes Host modes and models and sends the exact selection', async () => {
  const f = fixture(projectSnapshot())
  const created = []
  const presets = [
    { id: 'standard', name: 'Standard', isDefault: true },
    { id: 'ptc', name: 'PTC' },
    { id: 'broken', name: 'Broken', broken: 'composition failed' },
  ]
  const catalog = {
    default: { provider: 'deepseek', providerName: 'DeepSeek', model: 'v3', name: 'DeepSeek V3' },
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
      { provider: 'deepseek', providerName: 'DeepSeek', model: 'v3', name: 'DeepSeek V3' },
      { provider: 'deepseek', providerName: 'DeepSeek', model: 'r1', name: 'DeepSeek R1' },
    ] }],
    failures: [],
  }
  f.render({ listWorkspaces: async () => [ws('ws-1', 'Alpha')], listPresets: async () => presets, loadModels: async () => catalog, createSession: async (workspaceId, options) => { created.push([workspaceId, options]); return 'new-session' }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  const mode = within(dialog).getByLabelText('模式')
  const model = within(dialog).getByLabelText('模型')
  await waitFor(() => assert.equal(mode.value, 'standard'))
  assert.equal(within(mode).getByRole('option', { name: 'Broken · 不可用' }).disabled, true)
  fireEvent.change(mode, { target: { value: 'ptc' } })
  fireEvent.change(model, { target: { value: 'deepseek\u0000r1\u0000' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建并加入项目。')
  assert.deepEqual(created, [['ws-1', { agentPreset: 'ptc', model: { provider: 'deepseek', model: 'r1' } }]])
})

test('a refused workspace registration stays inline and never creates a session', async () => {
  const f = fixture(projectSnapshot())
  const created = []
  f.render({ listWorkspaces: async () => [], pickDirectory: async () => '/denied', createWorkspace: async () => { throw new Error('workspace/invalid-path') }, createSession: async id => { created.push(id); return 'new-session' }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '选择文件夹并添加' }))
  const failure = await within(dialog).findByRole('alert')
  assert.match(failure.textContent, /workspace\/invalid-path/)
  assert.deepEqual(created, [])
})

test('without a session list New session keeps the workspace picker', async () => {
  const f = fixture(projectSnapshot())
  f.render({ createSession: async () => 'new-session', listWorkspaces: async () => [ws('ws-1')], requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  assert.equal(within(dialog).getByRole('radio', { name: 'ws-1' }).checked, true)
  assert.equal(screen.queryByRole('dialog', { name: '在官方界面新建会话' }), null)
})


async function openWorkspacePicker() { const menu = await openProjectActions(); fireEvent.click(within(menu).getByRole('button', { name: '新建会话' })); return screen.findByRole('dialog', { name: '新建会话' }) }

test('new session creates in the chosen workspace and joins the project without navigating', async () => {
  const f = fixture(projectSnapshot())
  const created = [], joined = []
  f.render({ listWorkspaces: async () => [ws('ws-1', 'Alpha', '/home/u/alpha'), ws('ws-2', '', '/home/u/beta')], createSession: async workspaceId => { created.push(workspaceId); return 'new-session' }, requestJoin: async (source, projectId) => { joined.push([source, projectId]); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  assert.equal(within(dialog).queryByLabelText('启动内容（可选）'), null, 'without prompt capability the input is hidden')
  const alpha = await within(dialog).findByRole('radio', { name: 'Alpha' })
  assert.ok(within(dialog).getByText('/home/u/alpha'))
  assert.ok(within(dialog).getByRole('radio', { name: 'beta' }), 'a missing title falls back to the last path segment')
  fireEvent.click(alpha)
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建并加入项目。')
  assert.deepEqual(created, ['ws-1'], 'creation targets the chosen workspace')
  assert.deepEqual(joined, [[{ kind: 'sidebar', sessionId: 'new-session', displayTitle: '' }, 'p1']])
  assert.deepEqual(f.navigations, [], 'creation must not open the new session')
  assert.equal(screen.queryByRole('dialog', { name: '新建会话' }), null)
  assert.equal(f.calls.filter(command => command.type === 'add_card').length, 0, 'the dashboard never creates the card itself')
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'new-session', 'the created session opens in the native iframe preview')
})

test('cancelling the workspace picker creates and joins nothing and reports no error', async () => {
  const f = fixture(projectSnapshot())
  const created = [], joined = []
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async id => { created.push(id); return 'never' }, requestJoin: async (...args) => { joined.push(args); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '新建会话' }), null))
  assert.deepEqual(created, []); assert.deepEqual(joined, []); assert.deepEqual(f.navigations, [])
  assert.equal(screen.queryByText(/新建会话失败/), null, 'cancelling is not an error')
})

test('no workspace shows an empty picker and disables creation', async () => {
  const f = fixture(projectSnapshot())
  const created = []
  f.render({ listWorkspaces: async () => [], createSession: async id => { created.push(id); return 'never' }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  await within(dialog).findByText('还没有工作区；请先在左侧工作区列表添加文件夹')
  assert.equal(within(dialog).getByRole('button', { name: '在这里新建' }).disabled, true)
  assert.deepEqual(created, [])
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '新建会话' }), null))
})

test('a failed creation reports the host reason and joins nothing', async () => {
  const f = fixture(projectSnapshot())
  const joined = []
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async () => { throw new Error('workspace/unavailable') }, requestJoin: async (...args) => { joined.push(args); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  const toast = await screen.findByText('新建会话失败：workspace/unavailable')
  assert.equal(toast.closest('[role=alert]') !== null, true)
  assert.deepEqual(joined, [], 'a refused creation never reaches the membership step')
})

test('the workspace picker remembers the last choice and Enter never skips the message', async () => {
  const f = fixture(projectSnapshot())
  const created = [], prompted = []
  f.render({ listWorkspaces: async () => [ws('ws-1', 'Alpha'), ws('ws-2', 'Beta')], createSession: async id => { created.push(id); return 'new-session' }, promptSession: async (id, text) => { prompted.push([id, text]); return { ok: true } }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  const group = await within(dialog).findByRole('radiogroup', { name: '选择工作区' })
  fireEvent.keyDown(group, { key: 'ArrowDown' })
  assert.equal(within(dialog).getByRole('radio', { name: 'Beta' }).checked, true)
  fireEvent.keyDown(group, { key: 'Enter' })
  assert.equal(screen.queryByRole('dialog', { name: '新建会话' }) === null, false, 'Enter must not submit from the workspace list')
  assert.deepEqual(created, [], 'Enter does not create a session')
  assert.deepEqual(prompted, [])
  assert.equal(document.activeElement, within(dialog).getByLabelText('启动内容（可选）'), 'Enter moves into the optional message')
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建并加入项目。')
  assert.deepEqual(created, ['ws-2'])
  assert.deepEqual(prompted, [], 'an empty message sends nothing')
  const reopened = await openWorkspacePicker()
  assert.equal(within(reopened).getByRole('radio', { name: 'Beta' }).checked, true, 'the last choice is preselected')
})

test('an optional starting message is trimmed, counted and sent after join', async () => {
  const f = fixture(projectSnapshot())
  const created = [], joined = [], prompted = []
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async id => { created.push(id); return 'new-session' }, promptSession: async (id, text) => { prompted.push([id, text]); return { ok: true } }, requestJoin: async (source, projectId) => { joined.push([source, projectId]); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  const prompt = within(dialog).getByLabelText('启动内容（可选）')
  assert.equal(prompt.getAttribute('maxlength'), '20000')
  assert.equal(prompt.getAttribute('placeholder'), '输入第一条消息，创建后立即发送；留空则只创建空白会话。')
  fireEvent.change(prompt, { target: { value: '  开始这件事  ' } })
  assert.match(within(dialog).getByText(/\d+ \/ 20000/).textContent, /9 \/ 20000/)
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建、加入项目并开始执行。')
  assert.deepEqual(created, ['ws-1'])
  assert.deepEqual(joined, [[{ kind: 'sidebar', sessionId: 'new-session', displayTitle: '' }, 'p1']])
  assert.deepEqual(prompted, [['new-session', '开始这件事']], 'the trimmed message targets the created session')
  assert.deepEqual(f.navigations, [])
})

test('a failed starting message keeps the created and joined card and reports the reason', async () => {
  const f = fixture(projectSnapshot())
  const created = [], joined = [], prompted = []
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async id => { created.push(id); return 'new-session' }, promptSession: async (id, text) => { prompted.push([id, text]); return { ok: false, error: 'prompt/denied' } }, requestJoin: async (source, projectId) => { joined.push([source, projectId]); return { status: 'applied' } } })
  const dialog = await openWorkspacePicker()
  fireEvent.change(within(dialog).getByLabelText('启动内容（可选）'), { target: { value: 'do it' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  const toast = await screen.findByText('会话已创建并加入项目，但启动内容发送失败：prompt/denied')
  assert.equal(toast.closest('[role=alert]') !== null, true)
  assert.deepEqual(created, ['ws-1'])
  assert.deepEqual(joined, [[{ kind: 'sidebar', sessionId: 'new-session', displayTitle: '' }, 'p1']])
  assert.deepEqual(prompted, [['new-session', 'do it']])
  assert.equal(screen.queryByText('新会话已创建、加入项目并开始执行。'), null)
})

test('cancelling the picker with a typed message creates and sends nothing', async () => {
  const f = fixture(projectSnapshot())
  const created = [], prompted = []
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async id => { created.push(id); return 'never' }, promptSession: async (id, text) => { prompted.push([id, text]); return { ok: true } }, requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  fireEvent.change(within(dialog).getByLabelText('启动内容（可选）'), { target: { value: 'not sent' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: '新建会话' }), null))
  assert.deepEqual(created, []); assert.deepEqual(prompted, [])
})

test('operation toasts autodismiss successes, keep errors and dedupe repeated keys', async () => {
  const dismissed = []
  const toast = (key, extra = {}) => ({ key, signature: key, tone: 'status', message: key, onDismiss: () => dismissed.push(key), ...extra })
  render(React.createElement(OperationToasts, { toasts: [toast('saved', { auto: true }), toast('error', { tone: 'alert', message: 'boom' }), toast('saved', { message: 'saved again', auto: true })], autoDismissMs: 20 }))
  assert.equal(screen.getAllByRole('status').length, 1, 'a repeated key updates one entry')
  assert.equal(screen.getAllByRole('alert').length, 1)
  assert.match(screen.getByRole('status').textContent, /saved again/)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  assert.deepEqual(dismissed, ['saved'], 'only the success toast auto-dismisses')
  assert.equal(screen.getByRole('alert').textContent.includes('boom'), true)
})

test('operation toasts keep at most four newest entries', () => {
  const toasts = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, signature: key, tone: 'status', message: key, onDismiss() {} }))
  render(React.createElement(OperationToasts, { toasts }))
  const rendered = screen.getAllByRole('status')
  assert.deepEqual(rendered.map(node => node.textContent), ['e×', 'd×', 'c×', 'b×'])
})

test('dashboard feedback lives in a fixed toast stack outside the layout and closes on demand', async () => {
  const f = fixture(projectSnapshot())
  f.render({ listWorkspaces: async () => [ws('ws-1')], createSession: async () => 'new-session', requestJoin: async () => ({ status: 'applied' }) })
  const dialog = await openWorkspacePicker()
  fireEvent.click(within(dialog).getByRole('button', { name: '在这里新建' }))
  await screen.findByText('新会话已创建并加入项目。')
  const stack = document.querySelector('.sd-toasts')
  assert.ok(stack, 'the toast stack is rendered')
  assert.equal(getComputedStyle(stack).position, 'fixed')
  assert.equal(stack.closest('.sd-scroll'), null, 'toasts never push the scroll container')
  assert.equal(document.querySelectorAll('.sd-notice').length, 0)
  fireEvent.click(within(stack).getByRole('button', { name: '关闭此提示' }))
  await waitFor(() => assert.equal(document.querySelector('.sd-toasts'), null))
  assert.equal(f.client.getSnapshot().noticeMessage, null)
})

test('dashboard error notices persist as alert toasts until dismissed', async () => {
  const f = fixture(projectSnapshot())
  f.render()
  await screen.findByRole('article', { name: 'Project one' })
  act(() => { f.client.noticeKey('newSessionFailedReason', { reason: 'EACCES' }) })
  const toast = await screen.findByText('新建会话失败：EACCES')
  assert.equal(toast.closest('[role=alert]') !== null, true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  assert.ok(screen.getByText('新建会话失败：EACCES'))
  fireEvent.click(screen.getByRole('button', { name: '关闭此提示' }))
  await waitFor(() => assert.equal(screen.queryByText('新建会话失败：EACCES'), null))
})

test('manage reorders tag identities with the durable CAS revision and keeps the empty option out of the tag order', async () => {
  const initial = snapshot([card('Archived', { archivedAt: 300 })])
  initial.board.tags = [{ ...label('used', '已引用'), groupId: null }, { ...label('free', '可删除'), groupId: null }]; initial.board.orders.tag.ids = ['used', 'free']
  const f = fixture(initial); f.client.start(); await act(async () => { await f.client.refresh() })
  const mounted = render(React.createElement('section', { className: 'sd-root' }, React.createElement(ManageDialog, { board: initial.board, client: f.client, initialDimension: 'tag', busy: false, onClose() {} })))

  const tags = screen.getByRole('region', { name: '普通标签' })
  const toggle = within(tags).getByRole('button')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'a section starts collapsed and only summarises its content')
  fireEvent.click(toggle)
  const rows = within(tags).getAllByRole('listitem')
  assert.equal(rows.length, 2)
  assert.equal(within(rows[0]).getByRole('button', { name: '删除' }).disabled, false)
  assert.equal(within(rows[0]).getByRole('button', { name: '前移已引用' }).disabled, true)
  fireEvent.click(screen.getByRole('button', { name: '前移可删除' }))
  await waitFor(() => assert.equal(f.calls.length, 1))
  assert.deepEqual(f.calls[0], { type: 'reorder', dimension: 'tag', ids: ['free', 'used'], expectedRevision: 0 })
  mounted.unmount()
})

test('every manager section starts collapsed and tag groups reorder with the durable CAS revision', async () => {
  const initial = snapshot()
  initial.board.tagGroups = [
    { id: '__project__', name: '项目', color: null, builtin: true, revision: 0 },
    { id: 'g1', name: '组一', color: null, builtin: false, revision: 2 },
    { id: 'g2', name: '组二', color: null, builtin: false, revision: 3 },
  ]
  initial.board.orders.tagGroup = { dimension: 'tagGroup', ids: ['__project__', 'g1', 'g2'], revision: 5 }
  const f = fixture(initial); f.client.start(); await act(async () => { await f.client.refresh() })
  const mounted = render(React.createElement('section', { className: 'sd-root' }, React.createElement(ManageDialog, { board: initial.board, client: f.client, initialDimension: 'tag', busy: false, onClose() {} })))

  const heads = [...document.querySelectorAll('.sd-collapsible-head')]
  assert.deepEqual(heads.map(node => node.getAttribute('aria-expanded')), ['false', 'false', 'false'], 'the default view only shows a summary per dimension')
  assert.equal(heads[1].textContent, '▸标签组 3 个标签组')
  const sections = screen.getByRole('region', { name: '标签组' })
  fireEvent.click(within(sections).getByRole('button'))
  const rows = within(sections).getAllByRole('listitem')
  assert.deepEqual(rows.map(row => /^(项目|组一|组二)/.exec(row.textContent)?.[0]), ['项目', '组一', '组二'], 'groups follow orders.tagGroup')
  assert.equal(within(rows[0]).getByRole('button', { name: '前移项目' }).disabled, true, 'the first group cannot move earlier')
  fireEvent.click(within(rows[2]).getByRole('button', { name: '前移组二' }))
  await waitFor(() => assert.equal(f.calls.length, 1))
  assert.deepEqual(f.calls[0], { type: 'reorder', dimension: 'tagGroup', ids: ['__project__', 'g2', 'g1'], expectedRevision: 5 }, 'the group order is saved as its own dimension')
  mounted.unmount()
})

test('typing in a manager section keeps the same input node and its focus', async () => {
  const initial = snapshot()
  initial.board.tagGroups = [
    { id: '__project__', name: '项目', color: null, builtin: true, revision: 0 },
    { id: 'g1', name: '模块', color: null, builtin: false, revision: 0 },
  ]
  initial.board.orders.tagGroup = { dimension: 'tagGroup', ids: ['__project__', 'g1'], revision: 0 }
  initial.board.tags = [{ ...label('t1', '前端'), groupId: 'g1' }]
  initial.board.orders.tag.ids = ['t1']
  const f = fixture(initial); f.client.start(); await act(async () => { await f.client.refresh() })
  const mounted = render(React.createElement('section', { className: 'sd-root' }, React.createElement(ManageDialog, { board: initial.board, client: f.client, initialDimension: 'tag', busy: false, onClose() {} })))
  const section = screen.getByRole('region', { name: '普通标签' })
  fireEvent.click(within(section).getByRole('button'))
  const input = screen.getByLabelText('普通标签名称')
  input.focus()
  fireEvent.change(input, { target: { value: '新' } })
  assert.equal(screen.getByLabelText('普通标签名称'), input, 'the form input is not remounted by its own state update')
  assert.equal(document.activeElement, input)
  fireEvent.change(input, { target: { value: '新标签' } })
  assert.equal(screen.getByLabelText('普通标签名称'), input)
  assert.equal(document.activeElement, input)
  mounted.unmount()
})

test('dialog traps keyboard focus, labelled close and Escape restore trigger focus', () => {
  const trigger = document.createElement('button'); trigger.textContent = 'trigger'; document.body.append(trigger); trigger.focus()
  let closed = 0
  const mounted = render(React.createElement(Modal, { title: '键盘测试', onClose: () => { closed++ } }, React.createElement('button', null, '最后一个操作')))
  const panel = screen.getByRole('dialog', { name: '键盘测试' })
  const buttons = within(panel).getAllByRole('button')
  assert.equal(document.activeElement, buttons[0])
  buttons.at(-1).focus(); fireEvent.keyDown(document, { key: 'Tab' }); assert.equal(document.activeElement, buttons[0])
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, buttons.at(-1))
  fireEvent.keyDown(document, { key: 'Escape' }); assert.equal(closed, 1)
  mounted.unmount(); assert.equal(document.activeElement, trigger)
})

test('drawer focus restores a moved/recreated card by stable id and next card after removal', () => {
  const original = document.createElement('button'); original.dataset.cardId = 'moved'; original.textContent = 'old'
  const neighbor = document.createElement('button'); neighbor.dataset.cardId = 'neighbor'; neighbor.textContent = 'neighbor'
  document.body.append(original, neighbor); original.focus()
  const first = render(React.createElement(Modal, { title: '移动后焦点', onClose() {} }, 'contents'))
  original.remove()
  const recreated = document.createElement('button'); recreated.dataset.cardId = 'moved'; recreated.textContent = 'new'; document.body.append(recreated)
  first.unmount(); assert.equal(document.activeElement, recreated)
  recreated.focus()
  const second = render(React.createElement(Modal, { title: '移除后焦点', onClose() {} }, 'contents'))
  recreated.remove(); second.unmount(); assert.equal(document.activeElement, neighbor)
})

test('actual ModuleLoader browser bundle registers native matching root slots and renders its main component', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let exported
  const require = createRequire(import.meta.url)
  const moduleLoader = { load(entry) { assert.equal(entry.id, '@hsx/dsh-session-dashboard'); exported = entry.factory(id => { assert.ok(id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom', id); return require(id) }) } }
  dom.window.__ModuleLoader__ = moduleLoader
  vm.runInNewContext(source, { window: dom.window, console, setTimeout, clearTimeout, crypto: globalThis.crypto, document, HTMLElement, Node, MutationObserver, TextEncoder, URL, AbortController, performance, structuredClone }, { filename: 'lib/client.js' })
  assert.equal(typeof exported.apply, 'function')
  const entries = [], dispose = [], f = fixture(boardSnapshot([card('Bundled')])), localeSnapshot = { active: 'zh', revision: 1 }
  // A real Typert remote rejects an optional namespace that the Host did not
  // compose. The plugin must still register its sidebar entry; only clicking the
  // directory picker may report that this namespace is unavailable.
  const remote = new Proxy({ sessionDashboard: f.api, async $mount(contribution) { assert.equal(contribution.descriptors.length, 10); return () => {} } }, {
    get(target, prop) { if (prop in target) return target[prop]; throw new Error(`Unknown remote namespace: ${String(prop)}`) },
  })
  const ctx = {
    remote,
    uiWorkspace: { openSession: id => f.navigations.push(id) },
    locale: { register: () => () => {}, bind: () => translateLocale('zh'), getSnapshot: () => localeSnapshot, subscribe: () => () => {} },
    slots: { inject(_name, callback) { callback(); return () => {} }, register(options, component) { entries.push({ options, component }); return () => {} } },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup); return () => {} },
    inject(_keys, callback) { callback(ctx); return { async dispose() { for (const cleanup of dispose) cleanup() } } },
  }
  const unmount = await exported.apply(ctx)
  const main = entries.find(entry => entry.options.name === 'main'), sidebar = entries.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(main.options.key, 'session-dashboard'); assert.equal(sidebar.options.id, 'session-dashboard')
  assert.equal(sidebar.options.label(), '仪表板')
  const mounted = render(React.createElement(main.component, { renderSlot: () => null }))
  await openBoard(); await screen.findByRole('button', { name: '会话行操作：Bundled' })
  mounted.unmount(); await unmount()
})

test('a native sidebar drop shows an optimistic project row and reconciles once after a failure', async () => {
  const initial = snapshot([])
  initial.board.projects = [{ ...label('p1', '项目一'), tagIds: [] }]
  initial.board.orders.project.ids = ['p1', EMPTY]
  initial.board.preferences.entry = 'projects'
  const f = fixture(initial), joins = []
  const requestJoin = () => new Promise(resolve => { joins.push(resolve) })
  render(React.createElement(Dashboard, { client: f.client, openSession() {}, requestJoin }))
  const project = await screen.findByRole('article', { name: '项目一' })
  const drop = (title, id) => {
    const data = new Map([[NATIVE_SIDEBAR_DRAG_TYPE, JSON.stringify({ version: 1, sessionId: id, displayTitle: title })]])
    fireEvent.drop(project, { dataTransfer: { types: [...data.keys()], getData: type => data.get(type) ?? '', setData() {}, dropEffect: 'none' } })
  }

  drop('Optimistic session', 'native-optimistic')
  await screen.findByText('Optimistic session')
  assert.ok(screen.getByText('正在加入项目…'))
  await act(async () => { joins[0]({ status: 'applied' }); await Promise.resolve() })
  await waitFor(() => assert.equal(screen.queryByText('Optimistic session'), null))

  let refreshes = 0
  const refresh = f.client.refresh
  f.client.refresh = async () => { refreshes += 1; return refresh() }
  drop('Confirming session', 'native-confirming')
  await screen.findByText('Confirming session')
  await act(async () => { joins[1]({ status: 'failed' }); await Promise.resolve() })
  await waitFor(() => assert.equal(screen.queryByText('Confirming session'), null))
  assert.equal(refreshes, 1, 'a failed join re-reads exactly one snapshot before clearing the optimistic row')
})

test('the manage dialog edits the board-wide status list; built-ins stay locked and deleting a status unplaces its cards', async () => {
  const initial = boardSnapshot([card('A', { status: 'accepted', placement: { kind: 'custom', statusId: 'dev' }, acceptedAt: 300, reviewAt: null, decision: { kind: 'accepted', episodeId: 'round-1', at: 300 } })])
  initial.board.statuses = [label('dev', '开发')]
  initial.board.orders.status.ids = [...initial.board.orders.status.ids, 'dev']
  const f = fixture(initial)
  f.render(); await openBoard()
  const more = screen.getByRole('button', { name: '更多操作', exact: true }); fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: '分类与排列', exact: true }))
  const manage = screen.getByRole('dialog', { name: '分类与展示排列' })
  const section = within(manage).getByRole('region', { name: '状态与自定义状态' })
  const row = name => within(section).getByText(name, { exact: true }).closest('[role=listitem]')
  // Built-ins are system-owned: they can be ordered but never renamed or removed.
  for (const name of ['进行中', '待确认', '待验收', '已验收']) {
    const entry = row(name)
    assert.equal(within(entry).queryByRole('button', { name: '编辑' }), null, `${name} cannot be edited`)
    assert.equal(within(entry).queryByRole('button', { name: '删除' }), null, `${name} cannot be deleted`)
  }
  assert.ok(within(row('开发')).getByRole('button', { name: '编辑' }))
  // A custom status is created for the whole board, with no project picker.
  assert.equal(within(section).queryByLabelText('所属项目'), null)
  fireEvent.change(within(section).getByLabelText('状态名称'), { target: { value: '验证' } })
  fireEvent.click(within(section).getByRole('button', { name: '新建状态' }))
  await waitFor(() => assert.equal(f.stored.board.statuses.length, 2))
  const created = f.calls.filter(call => call.type === 'create_label').at(-1)
  assert.equal(created.type, 'create_label'); assert.equal(created.dimension, 'status'); assert.equal(created.name, '验证')
  const added = f.stored.board.statuses.find(value => value.name === '验证')
  assert.equal(f.stored.board.orders.status.ids.includes(added.id), true)
  // Renaming uses the exact status revision.
  fireEvent.click(within(row('开发')).getByRole('button', { name: '编辑' }))
  fireEvent.change(within(section).getByLabelText('状态名称'), { target: { value: '开发中' } })
  fireEvent.click(within(section).getByRole('button', { name: '保存分类' }))
  await waitFor(() => assert.equal(f.stored.board.statuses.find(value => value.id === 'dev').name, '开发中'))
  const renamed = f.calls.filter(call => call.type === 'update_label').at(-1)
  assert.deepEqual([renamed.type, renamed.id, renamed.expectedRevision], ['update_label', 'dev', 0])
  // Deleting a status unplaces its cards and prunes the shared order.
  fireEvent.click(within(row('开发中')).getByRole('button', { name: '删除' }))
  fireEvent.click(within(section).getByRole('button', { name: '确认删除' }))
  await waitFor(() => assert.deepEqual(f.stored.board.statuses.map(value => value.name), ['验证']))
  assert.deepEqual(f.stored.board.cards[0].placement, { kind: 'unset' })
  assert.equal(f.stored.board.orders.status.ids.includes('dev'), false)
  const deleted = f.calls.filter(call => call.type === 'delete_label').at(-1)
  assert.equal(deleted.dimension, 'status')
})
test('row actions rename the native title, fork and archive a session from its row', async () => {
  const f = fixture(snapshot([card('Row action')]))
  const forks = [], joins = [], renames = []
  f.render({
    renameSession: async (id, title) => { renames.push([id, title]); f.stored.board.cards[0].hostTitle = title; return { ok: true, title } },
    forkSession: async id => { forks.push(id); return 'child-1' },
    requestJoin: async (source, projectId) => { joins.push([source, projectId]); return { status: 'applied' } },
  })
  const menu = await openRowMenu('Row action')
  fireEvent.click(within(menu).getByRole('button', { name: '编辑名称' }))
  const input = screen.getByLabelText('名称：Row action')
  assert.equal(input.value, 'Row action', 'renaming starts from the title the row shows')
  fireEvent.change(input, { target: { value: '重命名后的会话' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.equal(renames.length, 1))
  assert.deepEqual(renames[0], ['Row action', '重命名后的会话'])
  assert.equal(f.calls.filter(call => call.type === 'edit_card').length, 0, 'a native rename does not write a dashboard override')
  await screen.findByRole('button', { name: '会话行操作：重命名后的会话' })
  assert.equal(screen.queryByLabelText('名称：Row action'), null)
  fireEvent.click(screen.getByRole('button', { name: '会话行操作：重命名后的会话' }))
  fireEvent.click(within(screen.getByRole('group', { name: '会话行操作：重命名后的会话' })).getByRole('button', { name: '新建分支（Fork）' }))
  await waitFor(() => assert.equal(forks.length, 1))
  assert.equal(forks[0], 'Row action')
  await waitFor(() => assert.equal(joins.length, 1))
  assert.deepEqual(joins[0][0], { kind: 'sidebar', sessionId: 'child-1', displayTitle: '重命名后的会话 （fork）' })
  assert.equal(joins[0][1], null)
  fireEvent.click(screen.getByRole('button', { name: '会话行操作：重命名后的会话' }))
  fireEvent.click(within(screen.getByRole('group', { name: '会话行操作：重命名后的会话' })).getByRole('button', { name: '归档', exact: true }))
  await waitFor(() => assert.equal(f.calls.filter(call => call.type === 'archive').length, 1))
  assert.equal(f.calls.find(call => call.type === 'archive').archived, true)
})

test('项目卡会话行的拖动把手只携带项目投放数据，点击不会打开移动对话框', async () => {
  const initial = projectSnapshot()
  initial.board.cards = [card('Row action', { projectId: 'p1' })]
  const f = fixture(initial)
  const joins = []
  f.render({ requestJoin: async (source, projectId) => { joins.push([source, projectId]); return { status: 'applied' } } })
  const grip = await screen.findByRole('button', { name: '拖动到项目卡片以移动：Row action' })
  assert.equal(grip.title, '拖动到项目卡片以移动：Row action')
  assert.equal(grip.draggable, true)
  assert.equal(grip.disabled, false)
  const data = new Map(), transfer = { types: [], setData(type, value) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type) }, getData: type => data.get(type) ?? '', effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(grip, { dataTransfer: transfer })
  assert.ok(transfer.types.includes(PROJECT_DRAG_TYPE), 'the grip carries the dedicated project drag type')
  assert.equal(transfer.types.includes('text/plain'), false, 'the grip never uses the native text channel')
  assert.equal(transfer.effectAllowed, 'move')
  const stored = f.stored.board.cards[0]
  assert.deepEqual(JSON.parse(data.get(PROJECT_DRAG_TYPE)), { kind: 'tracked', sessionId: 'Row action', membershipId: stored.membershipId, metadataRevision: stored.metadataRevision, binding: reviewBinding(stored), serviceId: f.client.serviceId })
  fireEvent.click(grip)
  await act(async () => { await Promise.resolve() })
  assert.equal(joins.length, 0, 'clicking the grip is a no-op instead of opening the membership flow')
  assert.equal(screen.queryByRole('dialog', { name: '加入或移动到项目' }), null)
})
test('归档的会话行拖动把手禁用且说明不能移动', () => {
  let dragged = 0
  const actions = { onTitle: async () => ({ ok: true }), onArchive: async () => ({ ok: true }), onFork: async () => ({ ok: true }), onMoveDrag: () => { dragged += 1 }, report() {} }
  render(React.createElement(SessionRowHead, { card: card('Archived row', { archivedAt: 300 }), titleClassName: 'sd-projectrow-title', onOpen() {}, actions }))
  const grip = screen.getByRole('button', { name: '归档的会话不能移动' })
  assert.equal(grip.disabled, true)
  assert.equal(grip.draggable, false)
  fireEvent.dragStart(grip, { dataTransfer: { types: [], setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' } })
  assert.equal(dragged, 0, 'an archived row never starts a project drag')
})
test('row actions fall back to the dashboard title when the host refuses, keeping the input on a conflict', async () => {
  const f = fixture(snapshot([card('Row action')]))
  const renames = []
  f.render({ renameSession: async (id, title) => { renames.push([id, title]); return { ok: false, error: '宿主拒绝改名' } } })
  f.failEdit = true
  const menu = await openRowMenu('Row action')
  fireEvent.click(within(menu).getByRole('button', { name: '编辑名称' }))
  const input = screen.getByLabelText('名称：Row action')
  fireEvent.change(input, { target: { value: '仅看板标题' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.equal(renames.length, 1))
  const row = document.querySelector('[data-card-id="Row action"]')
  assert.ok(row)
  const alert = await screen.findByRole('alert')
  assert.match(alert.textContent, /修改|保存失败|冲突/)
  assert.equal(screen.getByLabelText('名称：Row action').value, '仅看板标题')
  f.failEdit = false
  fireEvent.keyDown(screen.getByLabelText('名称：Row action'), { key: 'Enter' })
  await waitFor(() => assert.equal(f.calls.filter(call => call.type === 'edit_card').length, 1))
  const edit = f.calls.find(call => call.type === 'edit_card')
  assert.equal(edit.titleOverride, '仅看板标题')
  await screen.findByText('宿主拒绝改名，已仅保存看板标题。')
  assert.equal(screen.queryByLabelText('名称：Row action'), null)
})

test('archiving a running session from its row asks for explicit confirmation', async () => {
  const f = fixture(snapshot([card('Busy', { status: 'in_progress', placement: { kind: 'unset' }, runtime: fact({ phase: 'running', episodeId: 'round-2', endedAt: null }) })]))
  f.render()
  const menu = await openRowMenu('Busy')
  fireEvent.click(within(menu).getByRole('button', { name: '归档', exact: true }))
  const confirm = await screen.findByRole('alert')
  assert.match(confirm.textContent, /仍在运行/)
  assert.equal(f.calls.filter(call => call.type === 'archive').length, 0)
  fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
  await waitFor(() => assert.equal(f.calls.filter(call => call.type === 'archive').length, 1))
  assert.equal(f.calls.find(call => call.type === 'archive').confirmedRunning, true)
})
test('opening rename prefills the current title and an unchanged save writes nothing', async () => {
  const f = fixture(snapshot([card('Row action')]))
  const renames = []
  f.render({ renameSession: async (id, title) => { renames.push([id, title]); return { ok: true, title } } })
  const menu = await openRowMenu('Row action')
  fireEvent.click(within(menu).getByRole('button', { name: '编辑名称' }))
  const input = screen.getByLabelText('名称：Row action')
  assert.equal(input.value, 'Row action')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.equal(screen.queryByLabelText('名称：Row action'), null))
  assert.equal(renames.length, 0, 'an unchanged title never calls the native rename')
  assert.equal(f.calls.filter(call => call.type === 'edit_card').length, 0)
})

test('clearing the title follows the native title without renaming it', async () => {
  const f = fixture(snapshot([card('Row action', { titleOverride: '本地标题' })]))
  const renames = []
  f.render({ renameSession: async (id, title) => { renames.push([id, title]); return { ok: true, title } } })
  const menu = await openRowMenu('本地标题')
  fireEvent.click(within(menu).getByRole('button', { name: '编辑名称' }))
  const input = screen.getByLabelText('名称：本地标题')
  assert.equal(input.value, '本地标题', 'a dashboard override is prefilled')
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.equal(f.calls.filter(call => call.type === 'edit_card').length, 1))
  assert.equal(f.calls.find(call => call.type === 'edit_card').titleOverride, null)
  assert.equal(renames.length, 0, 'clearing the override is not a native rename')
  await screen.findByText('已恢复跟随原生标题。')
  assert.equal(screen.queryByLabelText('名称：本地标题'), null)
})
