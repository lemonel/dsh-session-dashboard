import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { StateControl } from '../lib/frontend/StateControl.js'
import { ProjectOverview } from '../lib/frontend/Projects.js'
import { setPortalRenderer } from '../lib/frontend/portal.js'
import { attentionLabel, attentionReason, attentionTone, statusBucketKind, statusColorOf, statusFace, terminalOutcome } from '../lib/frontend/view-model.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, PointerEvent: dom.window.PointerEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
// The plugin entry installs the host react-dom portal; these unit renders install
// the same shape once the document exists.
const { createPortal } = await import('react-dom')
setPortalRenderer(createPortal)
afterEach(() => { cleanup(); document.body.replaceChildren() })

const status = (id, name = id, color = null) => ({ id, name, color, createdAt: 1, revision: 0 })
function boardWith(statuses = [], cards = []) {
  const board = emptyBoard()
  board.statuses = statuses
  for (const row of statuses) board.orders.status.ids.push(row.id)
  board.cards = cards
  return board
}
function card(extra = {}) {
  return {
    sessionId: extra.sessionId ?? 'a', membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'Session', titleOverride: null, workspace: '/w',
    projectId: null, tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null, workflowRevision: 0,
    runtime: { ...unknownRuntime(), sync: 'synced', phase: 'not_started', episodeId: null, episodeOrder: 0, sourceLive: true, attention: 'none' },
    decision: null, joinedAt: 1, activityAt: 2, updatedAt: 2, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 1, lifecycleRevision: 1, ...extra,
  }
}

test('every status face paints one colour: built-in tones, the custom colour, and the faint fallback', () => {
  const board = boardWith([status('doing', '开发中', '#123456'), status('plain', '未上色')], [
    card({ sessionId: 'a' }), card({ sessionId: 'b', placement: { kind: 'custom', statusId: 'doing' } }),
    card({ sessionId: 'c', placement: { kind: 'custom', statusId: 'plain' } }), card({ sessionId: 'd', placement: { kind: 'unset' } }),
    card({ sessionId: 'e', status: 'accepted', decision: { kind: 'accepted', episodeId: 'round-1', at: 2 }, placement: { kind: 'builtin', status: 'accepted' }, runtime: { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', sourceLive: true, attention: 'none' }, acceptedAt: 2 }),
    card({ sessionId: 'f', status: 'pending_confirm', placement: { kind: 'builtin', status: 'pending_confirm' }, runtime: { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', attention: 'none' }, reviewAt: 2 }),
    card({ sessionId: 'g', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, runtime: { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', attention: 'none' }, reviewAt: 2 }),
  ])
  assert.equal(statusColorOf(board, 'in_progress'), 'var(--sd-info)')
  assert.deepEqual(['in_progress', 'pending_confirm', 'pending_review', 'accepted'].map(statusBucketKind), ['workflow', 'workflow', 'workflow', 'workflow'], 'only the persisted workflow states are system gates')
  assert.equal(statusBucketKind('doing'), 'custom', 'custom board labels are user placement, not workflow states')
  assert.equal(statusBucketKind('unset'), 'unset')
  assert.equal(statusBucketKind('terminal:stopped'), 'terminal')
  const stoppedFace = statusFace(board, card({ runtime: { ...unknownRuntime(), sync: 'synced', phase: 'interrupted', sourceLive: true, attention: 'interrupted', turnEnd: { kind: 'aborted', cause: 'user' } } }))
  assert.deepEqual({ kind: stoppedFace.kind, bucket: stoppedFace.bucket, label: stoppedFace.label, color: stoppedFace.color }, { kind: 'terminal', bucket: 'terminal:stopped', label: '已停止', color: 'var(--sd-danger)' }, 'the chip face and the summary share this projection')
  assert.equal(statusColorOf(board, 'pending_confirm'), 'var(--sd-info)', '待确认 intentionally shares the in-progress tone; the spinner is the live signal')
  assert.equal(statusColorOf(board, 'pending_review'), 'var(--sd-warn)')
  assert.equal(statusColorOf(board, 'accepted'), 'var(--sd-ok)')
  assert.equal(statusColorOf(board, 'doing'), '#123456')
  assert.equal(statusColorOf(board, 'plain'), 'var(--sd-faint)', 'a custom status without a colour falls back instead of inventing one')
  assert.equal(statusColorOf(board, 'unset'), 'var(--sd-faint)')
  render(React.createElement('div', null, board.cards.map(row => React.createElement(StateControl, { key: row.sessionId, board, card: row, readOnly: true }))))
  const chips = [...document.querySelectorAll('.sd-status')]
  assert.deepEqual(chips.map(node => node.style.getPropertyValue('--sd-chip-color')), ['var(--sd-info)', '#123456', 'var(--sd-faint)', 'var(--sd-faint)', 'var(--sd-ok)', 'var(--sd-info)', 'var(--sd-warn)'])
  assert.deepEqual(chips.map(node => node.textContent), ['进行中', '开发中', '未上色', '未设置状态', '已验收', '待确认', '待验收'])
})

test('the derived attention layer marks the status instead of replacing it', () => {
  const board = boardWith([status('doing', '开发中', '#123456')], [card({ placement: { kind: 'custom', statusId: 'doing' }, runtime: { ...unknownRuntime(), sync: 'synced', phase: 'waiting_input', episodeId: 'round-1', sourceLive: true, attention: 'answer' } })])
  render(React.createElement(StateControl, { board, card: board.cards[0], readOnly: true }))
  const chip = document.querySelector('.sd-status')
  assert.equal(chip.textContent.includes('开发中'), true, 'the real status text is still the label')
  assert.equal(chip.textContent.includes('待输入'), true, 'the attention mark sits next to it, not in place of it')
  assert.equal(chip.querySelector('.sd-attentionmark').style.getPropertyValue('--sd-chip-color'), '')
  assert.equal(chip.querySelector('.sd-attentionmark').getAttribute('role'), 'img')
  assert.match(chip.querySelector('.sd-attentionmark').getAttribute('aria-label'), /需我操作：等待输入/, 'the mark carries the concrete reason')
  assert.equal(getComputedStyle(document.querySelector('.sd-root') ?? document.body).getPropertyValue('--sd-danger').trim(), '', 'colour comes from the stylesheet token, not an inline literal')
  assert.equal(attentionReason(board.cards[0]), '等待输入')
  assert.equal(attentionLabel(board.cards[0]), '待输入')
  assert.equal(attentionTone(board.cards[0]), 'warn')
})

test('the picker portals to the body, lists coloured options and returns the chosen command', () => {
  const board = boardWith([status('doing', '开发中', '#123456')], [card()])
  const changes = []
  render(React.createElement(StateControl, { board, card: board.cards[0], onChangeState: (_card, id) => { changes.push(id) } }))
  fireEvent.click(screen.getByRole('button', { name: '更改状态：Session' }))
  const list = screen.getByRole('listbox', { name: '更改状态：Session' })
  assert.equal(list.parentElement, document.body, 'the panel is portalled to the body, outside the clipped rows')
  assert.equal(list.style.position, 'fixed')
  assert.equal(list.style.maxHeight, '240px')
  const options = within(list).getAllByRole('option')
  assert.deepEqual(options.map(node => node.textContent.replace('✓', '').trim()), ['开发中', '明确选择未设置状态'])
  assert.deepEqual(options.map(node => node.style.getPropertyValue('--sd-chip-color')), ['#123456', 'var(--sd-faint)'], 'each option paints the same tone as its chip')
  assert.deepEqual(options.map(node => node.getAttribute('aria-selected')), ['false', 'false'], 'a built-in placement is not one of the pickable rows')
  fireEvent.click(options[0])
  assert.deepEqual(changes, ['doing'])
  assert.equal(screen.queryByRole('listbox'), null, 'picking closes the panel')
})

test('the picker is keyboard operable: arrows move, Enter selects, Escape returns focus', async () => {
  const board = boardWith([status('one', 'One'), status('two', 'Two')], [card()])
  const changes = []
  render(React.createElement(StateControl, { board, card: board.cards[0], onChangeState: (_card, id) => { changes.push(id) } }))
  const trigger = screen.getByRole('button', { name: '更改状态：Session' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const list = screen.getByRole('listbox')
  assert.equal(document.activeElement, list, 'the panel takes focus when it opens')
  fireEvent.keyDown(list, { key: 'End' })
  fireEvent.keyDown(list, { key: 'Enter' })
  assert.deepEqual(changes, [null], 'End moves to the unset option and Enter selects it')
  await act(async () => {})
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const reopened = screen.getByRole('listbox')
  fireEvent.keyDown(reopened, { key: 'Escape' })
  assert.equal(screen.queryByRole('listbox'), null)
  assert.equal(document.activeElement, trigger, 'Escape hands focus back to the trigger')
})

test('an outside pointerdown closes the picker without choosing', () => {
  const board = boardWith([status('one', 'One')], [card()])
  const changes = []
  render(React.createElement(StateControl, { board, card: board.cards[0], onChangeState: (_card, id) => { changes.push(id) } }))
  fireEvent.click(screen.getByRole('button', { name: '更改状态：Session' }))
  assert.ok(screen.getByRole('listbox'))
  fireEvent.pointerDown(document.body)
  assert.equal(screen.queryByRole('listbox'), null)
  assert.deepEqual(changes, [])
})

test('a reviewable card routes the pick through acceptance, keeping the stay/unset meaning', async () => {
  const board = boardWith([status('doing', '开发中')], [card({ status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, runtime: { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', sourceLive: true, attention: 'none' }, reviewAt: 2 })])
  const reviewed = []
  render(React.createElement(StateControl, { board, card: board.cards[0], onChangeState: () => { throw new Error('choose_state must not run for a reviewable card') }, onReviewState: (_card, id) => { reviewed.push(id) } }))
  fireEvent.click(screen.getByRole('button', { name: '更改状态：Session' }))
  const list = screen.getByRole('listbox')
  assert.deepEqual(within(list).getAllByRole('option').map(node => node.textContent.replace('✓', '').trim()), ['开发中', '已验收'])
  fireEvent.click(within(list).getByRole('option', { name: '开发中' }))
  assert.deepEqual(reviewed, ['doing'])
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '更改状态：Session' }))
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '已验收' }))
  assert.deepEqual(reviewed, ['doing', null], 'accepting without a destination keeps the existing stay semantics')
})

test('a terminal system result takes over the chip text and its danger tone, without a second marker', () => {
  const cases = [
    [{ kind: 'error', error: { code: 'rate_limit', status: 429 } }, 'failed', '失败', '宿主执行非正常结束：error'],
    [{ kind: 'interrupted' }, 'interrupted', '已中断', '原始日志存在尚未闭合的执行；没有当前运行事实，不能推断正常完成或中断'],
    [{ kind: 'max-tokens' }, 'suspended', '已中断', '宿主执行非正常结束：max-tokens'],
    [{ kind: 'aborted', cause: 'user' }, 'interrupted', '已停止', '用户已停止当前执行；本轮没有正常完成，不能验收'],
    [{ kind: 'aborted', cause: 'hook' }, 'interrupted', '已中断', '宿主执行非正常结束：aborted（hook）'],
  ]
  for (const [turnEnd, phase, label, explanation] of cases) {
    const board = boardWith([], [card({ runtime: { ...unknownRuntime(), sync: 'synced', phase, episodeId: 'round-1', sourceLive: true, attention: phase === 'failed' ? 'failure' : 'interrupted', explanation, turnEnd } })])
    render(React.createElement(StateControl, { board, card: board.cards[0], readOnly: true }))
    const chip = document.querySelector('.sd-status')
    assert.equal(chip.textContent.includes(label), true, `${turnEnd.kind} chip text`)
    assert.equal(chip.textContent.includes('进行中'), false, 'the contradicted in-progress word is not shown beside the outcome')
    assert.equal(chip.getAttribute('data-status'), 'in_progress', 'the stored placement identity is unchanged')
    assert.equal(chip.getAttribute('data-terminal'), terminalOutcome(board.cards[0]))
    assert.equal(chip.style.getPropertyValue('--sd-chip-color'), 'var(--sd-danger)')
    assert.equal(document.querySelector('.sd-attentionmark'), null, 'the chip already carries the outcome, so no second mark is rendered')
    const title = chip.getAttribute('title')
    assert.match(title, /看板状态仍为进行中/, 'the title says only the label changed')
    assert.equal(title.includes(explanation), true, 'the host explanation is kept')
    const stored = board.cards[0]
    assert.equal(stored.status, 'in_progress')
    assert.deepEqual(stored.placement, { kind: 'builtin', status: 'in_progress' })
    cleanup(); document.body.replaceChildren()
  }
})

test('a non-terminal turn end keeps the attention mark instead of rewriting the chip', () => {
  const blocked = boardWith([], [card({ runtime: { ...unknownRuntime(), sync: 'synced', phase: 'suspended', episodeId: 'round-1', sourceLive: true, attention: 'none', turnEnd: { kind: 'blocked' } } })])
  render(React.createElement(StateControl, { board: blocked, card: blocked.cards[0], readOnly: true }))
  const marker = document.querySelector('.sd-attentionmark')
  assert.equal(marker?.textContent, '目标受阻')
  assert.equal(marker.getAttribute('data-tone'), 'warn')
  assert.equal(document.querySelector('.sd-status')?.textContent.includes('进行中'), true, 'a blocked goal is not a terminal run outcome')
  cleanup(); document.body.replaceChildren()
  const forked = boardWith([], [card({ runtime: { ...unknownRuntime(), sync: 'synced', phase: 'suspended', episodeId: 'round-1', sourceLive: true, attention: 'none', turnEnd: { kind: 'forked' } } })])
  render(React.createElement(StateControl, { board: forked, card: forked.cards[0], readOnly: true }))
  assert.equal(document.querySelector('.sd-attentionmark'), null, 'a variant without a human label stays neutral')
  cleanup(); document.body.replaceChildren()
})

test('a cold interrupted session still reads interrupted, while its explanation asks for a resync', () => {
  const turnEnd = { kind: 'interrupted' }
  const board = boardWith([], [card({ runtime: { ...unknownRuntime(), sync: 'synced', phase: 'interrupted', episodeId: 'round-1', sourceLive: false, attention: 'interrupted', explanation: '原始日志存在尚未闭合的执行；没有当前运行事实，不能推断正常完成或中断', turnEnd } })])
  render(React.createElement(StateControl, { board, card: board.cards[0], readOnly: true }))
  const chip = document.querySelector('.sd-status')
  assert.equal(chip.textContent.includes('已中断'), true, 'the system fact wins over the derived sync attention')
  assert.equal(chip.getAttribute('title').includes('原始日志存在尚未闭合的执行'), true, 'the chip keeps the concrete explanation')
  assert.equal(chip.style.getPropertyValue('--sd-chip-color'), 'var(--sd-danger)')
  assert.equal(document.querySelector('.sd-attentionmark'), null)
})

test('a project row shows the terminal outcome on the chip and never duplicates it inline', () => {
  const project = { id: 'p', name: 'Project', color: null, createdAt: 1, revision: 0, tagIds: [] }
  const board = boardWith([], [card({ projectId: 'p', runtime: { ...unknownRuntime(), sync: 'synced', phase: 'failed', episodeId: 'round-1', sourceLive: true, attention: 'failure', explanation: '宿主执行非正常结束：error', turnEnd: { kind: 'error', error: { code: 'rate_limit', status: 429 } } } })])
  board.projects = [project]; board.orders.project.ids = ['p', '__none__']
  render(React.createElement(ProjectOverview, { board, onOpen() {}, onOpenSession() {}, onCreate() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} }))
  assert.equal(document.querySelector('.sd-projectrow .sd-status')?.textContent.includes('失败'), true, 'the row chip itself carries the outcome')
  assert.equal(document.querySelector('.sd-projectrow .sd-attentioninline'), null, 'the same outcome is not repeated as a second label')
  cleanup(); document.body.replaceChildren()
})

test('a project row still labels non-terminal attention beside the chip', () => {
  const project = { id: 'p', name: 'Project', color: null, createdAt: 1, revision: 0, tagIds: [] }
  const board = boardWith([], [card({ projectId: 'p', runtime: { ...unknownRuntime(), sync: 'unknown', phase: 'suspended', episodeId: 'round-1', sourceLive: false, attention: 'sync', explanation: '这是持久化历史切面；请进入原会话等待宿主激活成功后重新同步，再进行人工验收' } })])
  board.projects = [project]; board.orders.project.ids = ['p', '__none__']
  render(React.createElement(ProjectOverview, { board, onOpen() {}, onOpenSession() {}, onCreate() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} }))
  const inline = document.querySelector('.sd-projectrow .sd-attentioninline')
  assert.equal(inline?.textContent, '同步异常')
  assert.equal(inline.getAttribute('data-tone'), 'warn')
})
