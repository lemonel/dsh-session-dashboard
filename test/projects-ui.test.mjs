import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { commandSchema } from '../lib/shared/commands.js'
import { ProjectOverview, ProjectDialog } from '../lib/frontend/Projects.js'
import { StaticLocaleProvider } from '../lib/frontend/i18n.js'
import { PROJECT_DRAG_TYPE } from '../lib/frontend/project-drag.js'
import { NATIVE_SIDEBAR_DRAG_TYPE } from '../lib/frontend/native-sidebar.js'
import { formatElapsed } from '../lib/frontend/Elapsed.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })
const label = (id, name = id, revision = 0) => ({ id, name, color: null, createdAt: 1, revision })
const project = (id, name = id, revision = 0) => ({ ...label(id, name, revision), tagIds: [] })
const status = (id, name = id, revision = 0) => label(id, name, revision)
function card(id, projectId, extra = {}) {
  return { sessionId: id, membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null }, hostTitle: id, titleOverride: null, workspace: '/workspace', projectId, tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'unset' }, origin: null, placementWitness: null, workflowRevision: 0, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, attention: 'none' }, decision: null, joinedAt: 1, activityAt: null, updatedAt: 1, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0, ...extra }
}
const localized = (child, active = 'zh') => React.createElement(StaticLocaleProvider, { active }, child)
function transfer(type, data) { return { types: [type], getData: name => name === type ? data : '', dropEffect: 'none' } }
function editFixture(initial, projectId = 'p', active = 'zh') {
  let board = structuredClone(initial), fail = false, closed = 0
  const calls = []
  const client = {
    serviceId: '22222222-2222-4222-8222-222222222222',
    getSnapshot: () => ({ error: fail ? 'opaque failure must not leak untranslated' : null }),
    mutate: async value => {
      const command = commandSchema.parse(value); calls.push(command)
      if (fail) return null
      const current = board.projects.find(value => value.id === command.projectId)
      if (command.type === 'create_project') board.projects.push({ ...project('new', command.name), color: command.color, tagIds: command.tagIds })
      if (command.type === 'update_project') { assert.equal(command.expectedProjectRevision, current.revision); Object.assign(current, { name: command.name, color: command.color, tagIds: command.tagIds }); current.revision++ }
      if (command.type === 'create_label') board.tags.push(label('new-tag', command.name.trim()))
      board.revision++
      queueMicrotask(() => mounted.rerender(view()))
      return { board: structuredClone(board), health: { state: 'ready', message: null, lastSyncAt: 1 } }
    },
  }
  const view = () => localized(React.createElement(ProjectDialog, { board, client, projectId, busy: false, onClose: () => { closed++ } }), active)
  const mounted = render(view())
  return { calls, client, mounted, get board() { return board }, set fail(value) { fail = value }, get closed() { return closed }, update(value) { board = structuredClone(value); mounted.rerender(view()) } }
}

test('project overview expands every project by default with inline sessions, tags and deduplicated counts', () => {
  const board = emptyBoard()
  board.projects = [project('empty', 'Empty'), { ...project('p', 'Project'), tagIds: ['t1', 't2', 't3', 't4'] }]
  board.tags = [label('t1', 'Shared'), label('t2', 'Second'), label('t3', 'Third'), label('t4', 'Fourth')]
  board.cards = [card('one', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' } }), card('one-dup', 'p', { membershipId: '44444444-4444-4444-8444-444444444444', sessionId: 'one', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' } }), card('two', 'p', { runtime: { ...unknownRuntime(), attention: 'answer' } }), card('archived', 'p', { archivedAt: 5 })]
  const opened = [], edited = [], deleted = [], created = [], added = [], reordered = []
  render(localized(React.createElement(ProjectOverview, { board, onOpen: id => opened.push(id), onCreate: () => created.push(true), onNewSession: id => added.push(id), onEdit: id => edited.push(id), onDelete: project => deleted.push(project.id), onReorder: ids => reordered.push(ids), onJoin() {} }), 'en'))
  const empty = screen.getByRole('article', { name: 'Empty' }), filled = screen.getByRole('article', { name: 'Project' })
  const stats = element => [...element.querySelectorAll('.sd-projectstats > b')].map(node => node.textContent)
  const emptyToggle = within(empty).getByRole('button', { name: 'Empty' }), filledToggle = within(filled).getByRole('button', { name: 'Project' })
  assert.deepEqual(stats(empty), ['0 sessions', '0 awaiting review', '0 need action'])
  assert.deepEqual(stats(filled), ['2 sessions', '1 awaiting review', '1 need action'], 'counts deduplicate memberships and ignore archived sessions')
  assert.equal(within(filled).queryByText('archived'), null)
  // every project starts expanded, with its sessions area inside its own card
  assert.equal(document.querySelectorAll('.sd-projectdrop').length, 2, 'all projects expand by default')
  assert.equal(emptyToggle.getAttribute('aria-expanded'), 'true'); assert.equal(filledToggle.getAttribute('aria-expanded'), 'true')
  const emptyRegion = within(empty).getByRole('region', { name: 'Empty · 0 sessions' })
  const filledRegion = within(filled).getByRole('region', { name: 'Project · 2 sessions' })
  assert.equal(emptyToggle.getAttribute('aria-controls'), emptyRegion.id)
  assert.equal(filledToggle.getAttribute('aria-controls'), filledRegion.id)
  assert.equal(emptyRegion.parentElement === empty, true, 'the sessions area sits inside its own project card')
  assert.equal(filledRegion.parentElement === filled, true)
  assert.equal(emptyRegion.style.position, '', 'the area is inline, not a positioned overlay')
  assert.equal(within(emptyRegion).getByText('No sessions').tagName, 'P')
  assert.deepEqual([...within(filledRegion).getByLabelText('Project tags').querySelectorAll('.sd-tag')].map(node => node.textContent), ['Shared', 'Second'], 'public tags live in the expansion footer, capped at two')
  assert.equal(within(filledRegion).getByText('+2').textContent, '+2')
  assert.equal(within(filledRegion).queryByText('Fourth'), null)
  assert.equal(within(emptyRegion).queryByLabelText('Project tags'), null)
  // the card collapses and expands on its own
  fireEvent.click(emptyToggle)
  assert.equal(emptyToggle.getAttribute('aria-expanded'), 'false'); assert.equal(empty.getAttribute('data-expanded'), null)
  assert.ok(!within(empty).queryByRole('region'))
  assert.equal(within(filled).getByRole('region', { name: 'Project · 2 sessions' }).isConnected, true, 'collapsing one project leaves the others expanded')
  fireEvent.click(emptyToggle)
  assert.equal(emptyToggle.getAttribute('aria-expanded'), 'true'); assert.equal(within(empty).getByRole('region', { name: 'Empty · 0 sessions' }).id, emptyRegion.id)
  // the card menu creates a project-bound session and maintains the project
  const actions = within(empty).getByRole('button', { name: 'Project actions: Empty' })
  fireEvent.click(actions)
  fireEvent.click(within(empty).getByRole('button', { name: 'New session' }))
  assert.deepEqual(added, ['empty'])
  fireEvent.click(actions)
  fireEvent.click(within(empty).getByRole('button', { name: 'Edit project' }))
  assert.deepEqual(edited, ['empty'])
  fireEvent.click(actions)
  fireEvent.click(within(empty).getByRole('button', { name: 'Delete project' }))
  assert.deepEqual(deleted, ['empty'])
  // the dashed tile stays the one create-project entry point in the grid
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  assert.deepEqual(created, [true])
})

test('a project name that the card cannot fit exposes its full text on hover', () => {
  const board = emptyBoard()
  const name = 'A very long project name that a fixed-width card cannot possibly fit'
  board.projects = [project('long', name)]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const toggle = screen.getByRole('button', { name })
  assert.equal(toggle.getAttribute('title'), name, 'hovering the name shows the full project name')
})

test('the project overview summarises every project-managed session in status order', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project'), project('q', 'Second')]
  board.statuses = [status('s1', '我的关注')]
  board.orders.status.ids.push('s1')
  board.cards = [
    card('progress', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, activityAt: 100, reviewAt: null }),
    card('review', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, activityAt: 200, reviewAt: 200 }),
    card('accepted', 'q', { status: 'accepted', placement: { kind: 'builtin', status: 'accepted' }, activityAt: 150, reviewAt: null }),
    card('custom', 'q', { status: 'in_progress', placement: { kind: 'custom', statusId: 's1' }, activityAt: 250, reviewAt: null }),
    card('archived', 'p', { archivedAt: 10 }),
    card('unassigned', null, { activityAt: 260 }),
  ]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const summary = filterPanel()
  assert.equal(within(summary).getByText('共 5 个会话').textContent, '共 5 个会话', 'archived sessions are not counted; unassigned ones are')
  const chips = [...summary.querySelectorAll('.sd-statuscount')]
  assert.deepEqual(chips.map(node => [node.querySelector('.sd-state-name')?.textContent, node.querySelector('b')?.textContent]), [
    ['进行中', '1'], ['待验收', '1'], ['已验收', '1'], ['我的关注', '1'], ['未设置状态', '1'],
  ], 'counts cover unassigned sessions too, in configured status order')
})

/** The filter bar lives in the page: every dimension is a category and the value
 *  chips are expanded by default, so the panel is already there. */
const filterPanel = () => screen.getByRole('group', { name: '筛选', exact: true })
const statusChip = (summary, name) => within(summary).getByRole('button', { name: new RegExp(`^${name} · `) })
const overview = board => localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} }))
const shownProjects = () => [...document.querySelectorAll('.sd-projectcard')].map(node => node.getAttribute('aria-label'))

test('session rows render the host facet strip in the meta line, one per row', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.cards = [card('one', 'p'), card('two', 'p')]
  const marker = row => React.createElement('span', { className: 'sd-facet-marker' }, `facet:${row.sessionId}`)
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {}, facets: marker })))
  const first = document.querySelector('[data-card-id="one"]')
  assert.equal(first.querySelector('.sd-facet-marker')?.textContent, 'facet:one')
  assert.notEqual(first.querySelector('.sd-facet-marker').closest('.sd-row'), null, 'the strip shares the status/meta line')
  assert.equal(document.querySelectorAll('.sd-facet-marker').length, 2, 'every session row gets its own strip')
})
const rowsOf = name => [...document.querySelector(`[data-project-id="${name}"]`)?.querySelectorAll('.sd-projectrow') ?? []].map(node => node.getAttribute('data-card-id')).sort()

test('summary counts use the same terminal face as the card status chips', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project'), project('q', 'Second')]
  const terminal = phase => ({ ...unknownRuntime(), sync: 'synced', phase, attention: phase === 'failed' ? 'failure' : 'interrupted' })
  board.cards = [
    card('run', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' } }),
    card('stop', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, runtime: { ...terminal('interrupted'), turnEnd: { kind: 'aborted', cause: 'user' } } }),
    card('cut', 'q', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, runtime: { ...terminal('interrupted'), turnEnd: { kind: 'interrupted' } }, membershipId: '22222222-2222-4222-8222-222222222222' }),
    card('fail', 'q', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, runtime: { ...terminal('failed'), turnEnd: { kind: 'error', error: { code: 'provider_error' } } }, membershipId: '33333333-3333-4333-8333-333333333333' }),
  ]
  render(overview(board))
  const summary = filterPanel()
  assert.deepEqual([...summary.querySelectorAll('.sd-statuscount')].map(node => [node.querySelector('.sd-state-name')?.textContent, node.querySelector('b')?.textContent]), [
    ['进行中', '1'], ['已停止', '1'], ['已中断', '1'], ['失败', '1'],
  ], 'terminal cards leave the stored in-progress bucket and form their own summary rows')
  const cardChip = document.querySelector('[data-card-id="stop"] .sd-status')
  assert.match(cardChip?.textContent ?? '', /已停止/, 'the project card already shows the terminal face')
  const stopChip = summary.querySelector('[data-status-count="terminal:stopped"]')
  assert.ok(stopChip, 'the summary uses the same terminal identity')
  assert.match(stopChip.textContent ?? '', /已停止/)
  assert.equal(stopChip.style.getPropertyValue('--sd-chip-color'), 'var(--sd-danger)', 'the terminal summary row shares the card danger tone')
  fireEvent.click(stopChip)
  assert.deepEqual(shownProjects(), ['Project'])
  assert.deepEqual(rowsOf('p'), ['stop'], 'the terminal summary row filters by the same derived status')
  assert.equal(stopChip.getAttribute('aria-pressed'), 'true')
  fireEvent.click(stopChip)
  assert.deepEqual(shownProjects(), ['Project', 'Second'])
})

// The summary counts cards, never host sessions: the backend refuses to turn a
// subagent-origin session into a card (see lifecycle-host), so no frontend filter
// can or should separate one here. These tests pin the summary-chip filter.
test('clicking a status chip filters projects and sessions to that status and clicking it again clears', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project'), project('q', 'Second'), project('r', 'Third')]
  board.statuses = [status('s1', '我的关注')]
  board.orders.status.ids.push('s1')
  board.cards = [
    card('p-progress', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' } }),
    card('p-review', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, membershipId: '66666666-6666-4666-8666-666666666666' }),
    card('q-progress', 'q', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '22222222-2222-4222-8222-222222222222' }),
    card('r-custom', 'r', { placement: { kind: 'custom', statusId: 's1' } }),
    card('q-custom', 'q', { placement: { kind: 'custom', statusId: 's1' }, membershipId: '33333333-3333-4333-8333-333333333333' }),
    card('p-archived', 'p', { archivedAt: 10, status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '44444444-4444-4444-8444-444444444444' }),
    card('orphan', 'missing-project', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '55555555-5555-4555-8555-555555555555' }),
  ]
  render(overview(board))
  const summary = filterPanel()
  assert.equal(within(summary).getByText('共 6 个会话').textContent, '共 6 个会话', 'archived cards are not counted; a missing project is still a counted card')
  const chip = statusChip(summary, '进行中')
  assert.equal(chip.tagName, 'BUTTON')
  assert.equal(chip.getAttribute('type'), 'button')
  assert.equal(chip.getAttribute('aria-pressed'), 'false')
  assert.equal(chip.getAttribute('aria-label'), '进行中 · 3 个会话；点击筛选包含此状态的项目', 'the chip states its status, count and filter action')
  assert.deepEqual(shownProjects(), ['Project', 'Second', 'Third'])
  assert.deepEqual(rowsOf('p'), ['p-progress', 'p-review'])

  fireEvent.click(chip)
  assert.equal(chip.getAttribute('aria-pressed'), 'true')
  assert.equal(chip.getAttribute('aria-label'), '进行中 · 3 个会话；已筛选，再次点击取消筛选')
  assert.deepEqual(shownProjects(), ['Project', 'Second'], 'only projects with the selected status stay visible')
  assert.deepEqual(rowsOf('p'), ['p-progress'], 'the card shows only its matching status rows')
  assert.deepEqual(rowsOf('q'), ['q-progress'])
  assert.ok(within(screen.getByRole('article', { name: 'Project' })).getByRole('region', { name: 'Project · 1 个会话' }), 'the card header counts only the visible rows')
  assert.equal(screen.queryByRole('article', { name: 'Third' }), null)
  assert.equal(document.querySelector('.sd-ghostcard'), null, 'the create-project ghost is hidden while a filter is active')
  assert.deepEqual([...document.querySelectorAll('.sd-statuscount')].map(node => node.querySelector('b')?.textContent), ['3', '1', '2'], 'clicking never changes the counts')
  assert.match(document.querySelector('.sd-projecthint')?.textContent ?? '', /正在筛选「进行中」/)

  fireEvent.click(chip)
  assert.equal(chip.getAttribute('aria-pressed'), 'false')
  assert.deepEqual(shownProjects(), ['Project', 'Second', 'Third'])
  assert.deepEqual(rowsOf('p'), ['p-progress', 'p-review'])
  assert.equal(document.querySelectorAll('.sd-ghostcard').length, 1, 'clearing restores the create-project entry')

  // Another status replaces the active filter; the same status toggles it off.
  fireEvent.click(statusChip(summary, '我的关注'))
  assert.deepEqual(shownProjects(), ['Second', 'Third'])
  assert.deepEqual(rowsOf('q'), ['q-custom'])
  assert.deepEqual(rowsOf('r'), ['r-custom'])
  fireEvent.click(statusChip(summary, '待验收'))
  assert.deepEqual(shownProjects(), ['Project'])
  assert.deepEqual(rowsOf('p'), ['p-review'])
  fireEvent.click(statusChip(summary, '待验收'))
  assert.deepEqual(shownProjects(), ['Project', 'Second', 'Third'])
})

test('a status filter with no renderable project explains itself and offers a clear action', async () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project')]
  board.cards = [card('orphan', 'missing-project', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' } })]
  render(overview(board))
  const summary = filterPanel()
  const chip = statusChip(summary, '进行中')
  fireEvent.click(chip)
  assert.deepEqual(shownProjects(), [], 'a counted card without its project cannot render a card')
  assert.equal(screen.getByRole('heading', { name: '当前筛选没有匹配项目' }).tagName, 'H3')
  assert.equal(chip.getAttribute('aria-pressed'), 'true', 'the active chip stays available to toggle the filter off')
  fireEvent.click(screen.getByRole('button', { name: '清除筛选并显示全部项目' }))
  assert.equal(screen.getByRole('article', { name: 'Project' }).getAttribute('data-expanded'), 'true')
  assert.equal(chip.getAttribute('aria-pressed'), 'false')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(document.activeElement, within(screen.getByRole('article', { name: 'Project' })).getByRole('button', { name: 'Project' }), 'clearing the empty state returns focus to the first restored project')
})

test('a filter whose chip disappears can still be cleared', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project')]
  board.cards = [card('p-run', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' } })]
  const view = render(overview(board))
  const summary = filterPanel()
  fireEvent.click(statusChip(summary, '进行中'))
  assert.deepEqual(shownProjects(), ['Project'])

  // The only matching card moves out of the bucket: the active chip disappears,
  // but the view must still expose a way back to every project.
  board.cards = [card('p-review', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' } })]
  view.rerender(overview(board))
  assert.equal(screen.queryByRole('button', { name: /^进行中 · / }), null)
  assert.equal(screen.getByRole('heading', { name: '当前筛选没有匹配项目' }).tagName, 'H3')
  fireEvent.click(screen.getByRole('button', { name: '清除筛选并显示全部项目' }))
  assert.deepEqual(shownProjects(), ['Project'])
  assert.deepEqual(rowsOf('p'), ['p-review'])
})

test('keyboard reorder under a status filter moves relative to visible projects and keeps hidden positions', () => {
  const board = emptyBoard()
  board.projects = [project('a', 'A'), project('h', 'Hidden'), project('b', 'B')]
  board.orders.project.ids = ['a', 'h', 'b']
  board.cards = [
    card('a-run', 'a', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' } }),
    card('h-review', 'h', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' } }),
    card('b-run', 'b', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '22222222-2222-4222-8222-222222222222' }),
  ]
  const reordered = []
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder: ids => reordered.push(ids), onJoin() {} })))
  const summary = filterPanel()
  fireEvent.click(statusChip(summary, '进行中'))
  assert.deepEqual(shownProjects(), ['A', 'B'], 'Hidden is not part of the filtered view')
  const grip = within(screen.getByRole('article', { name: 'B' })).getByRole('button', { name: '拖动排序：B；也可用左右方向键移动' })
  fireEvent.keyDown(grip, { key: 'ArrowLeft' })
  assert.deepEqual(reordered.at(-1), ['b', 'a', 'h'], 'B moves before A while Hidden keeps its slot')
})

test('the selector composes dimensions: AND across them, OR inside one tag group', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project'), project('q', 'Second')]
  board.tagGroups = [{ id: 'g1', name: '模块', color: null, builtin: false, revision: 0 }]
  board.orders.tagGroup.ids = ['__project__', 'g1']
  board.tags = [{ ...label('t1', '前端'), groupId: 'g1' }, { ...label('t2', '后端'), groupId: 'g1' }]
  board.orders.tag.ids = ['t1', 't2']
  board.cards = [
    card('p-a', 'p', { tagIds: ['t1'], placement: { kind: 'builtin', status: 'in_progress' } }),
    card('p-b', 'p', { tagIds: ['t2'], placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '22222222-2222-4222-8222-222222222222' }),
    card('q-a', 'q', { tagIds: ['t1'], placement: { kind: 'builtin', status: 'in_progress' }, membershipId: '33333333-3333-4333-8333-333333333333' }),
  ]
  render(overview(board))
  const summary = filterPanel()
  fireEvent.click(statusChip(summary, '进行中'))
  assert.deepEqual(shownProjects(), ['Project', 'Second'])
  fireEvent.click(within(summary).getByRole('button', { name: /^前端 · / }))
  assert.deepEqual(shownProjects(), ['Project', 'Second'], 'a tag in another dimension is ANDed with the status')
  assert.deepEqual(rowsOf('p'), ['p-a']); assert.deepEqual(rowsOf('q'), ['q-a'])
  fireEvent.click(within(summary).getByRole('button', { name: /^后端 · / }), { shiftKey: true })
  assert.deepEqual(shownProjects(), ['Project', 'Second'], 'two values of one group are ORed')
  assert.deepEqual(rowsOf('p'), ['p-a', 'p-b'])
  fireEvent.click(statusChip(summary, '进行中'))
  assert.deepEqual(rowsOf('p'), ['p-a', 'p-b'], 'clearing the status keeps the tag-group selection active')
  assert.deepEqual(rowsOf('q'), ['q-a'])
})

test('the selector also narrows the unassigned and archived buckets', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.tagGroups = [{ id: 'g1', name: '模块', color: null, builtin: false, revision: 0 }]
  board.orders.tagGroup.ids = ['__project__', 'g1']
  board.tags = [{ ...label('t1', '前端'), groupId: 'g1' }, { ...label('t2', '后端'), groupId: 'g1' }]
  board.orders.tag.ids = ['t1', 't2']
  board.cards = [
    card('p-a', 'p', { tagIds: ['t1'] }),
    card('u-a', null, { tagIds: ['t1'], membershipId: '22222222-2222-4222-8222-222222222222' }),
    card('u-b', null, { tagIds: ['t2'], membershipId: '33333333-3333-4333-8333-333333333333' }),
    card('arch', 'p', { tagIds: ['t1'], archivedAt: 10, membershipId: '44444444-4444-4444-8444-444444444444' }),
  ]
  render(overview(board))
  const summary = filterPanel()
  const bucketRows = bucket => [...document.querySelectorAll(`[data-bucket="${bucket}"] [data-card-id]`)].map(node => node.dataset.cardId)
  const openBucket = name => { const region = screen.getByRole('region', { name }); const toggle = within(region).getByRole('button'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle); return region }
  openBucket('未归属会话'); openBucket('已归档会话')
  assert.deepEqual(bucketRows('unassigned'), ['u-a', 'u-b'])
  assert.deepEqual(bucketRows('archive'), ['arch'])
  const front = within(summary).getByRole('button', { name: /^前端 · / })
  assert.match(front.getAttribute('aria-label') ?? '', /2 个会话/, 'counts include unassigned sessions but not archived ones')
  fireEvent.click(front)
  assert.deepEqual(rowsOf('p'), ['p-a'])
  assert.deepEqual(bucketRows('unassigned'), ['u-a'], 'the unassigned bucket is narrowed by the same selection')
  assert.deepEqual(bucketRows('archive'), ['arch'], 'the archived bucket is narrowed too')
  fireEvent.click(within(summary).getByRole('button', { name: /^后端 · / }))
  assert.equal(screen.queryByRole('region', { name: '已归档会话' }), null, 'a bucket with no match disappears')
  assert.deepEqual(bucketRows('unassigned'), ['u-b'])
})

test('a running project session shows an absolute elapsed clock that a remount does not reset', async () => {
  assert.deepEqual([formatElapsed(0), formatElapsed(-500), formatElapsed(61_000), formatElapsed(3_661_000)], ['00:00', '00:00', '01:01', '1:01:01'])
  const board = emptyBoard()
  board.projects = [project('p', 'Project')]
  const startedAt = Date.now() - 61_000
  const running = extra => ({ ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'running', attention: 'none', episodeId: 'round-1', startedAt, ...extra })
  board.cards = [
    card('run', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running() }),
    card('children', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running({ phase: 'completed', activeAgents: 2 }) }),
    card('parked', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running({ phase: 'suspended', attention: 'resume', activeAgents: 1 }) }),
    card('waiting', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running({ phase: 'waiting_input', attention: 'answer' }) }),
    card('cold', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running({ sourceLive: false }) }),
    card('no-start', 'p', { placement: { kind: 'builtin', status: 'in_progress' }, reviewAt: null, runtime: running({ startedAt: null }) }),
  ]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const box = id => document.querySelector(`[data-card-id="${id}"]`)
  const clock = id => box(id)?.querySelector('.sd-elapsed')?.textContent ?? null
  assert.match(clock('run'), /^已运行 01:0\d$/, 'the main turn runs since the durable round start')
  assert.match(clock('children'), /^已运行 01:0\d$/, 'children still running keep the round clock alive')
  assert.match(clock('parked'), /^已运行 01:0\d$/, 'a parked main waiting on children keeps the round clock')
  assert.equal(clock('waiting'), null, 'waiting for a human is not running time')
  assert.equal(clock('cold'), null, 'a cold snapshot has no live clock')
  assert.equal(clock('no-start'), null, 'an unknown start has no clock')
  // The clock is absolute: a fresh mount (or page switch) recomputes from startedAt.
  const before = clock('run')
  cleanup()
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  assert.equal(clock('run'), before, 'a remount keeps the same elapsed value instead of restarting at 00:00')
})

test('project sessions follow the configured status order, newest activity first inside one status', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project')]
  board.cards = [
    card('review-old', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, activityAt: 200, reviewAt: 200 }),
    card('unset', 'p', { placement: { kind: 'unset' }, activityAt: 500 }),
    card('progress', 'p', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, activityAt: 100, reviewAt: null }),
    card('review-new', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, activityAt: 300, reviewAt: 300 }),
  ]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const filled = screen.getByRole('article', { name: 'Project' })
  assert.deepEqual([...filled.querySelectorAll('.sd-projectrow')].map(node => node.dataset.cardId), ['progress', 'review-new', 'review-old', 'unset'])
})

test('project drops accept each dedicated payload only, never native text/plain, malformed or cancelled drags', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  const joined = []
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin: (...args) => joined.push(args) })))
  const target = screen.getByRole('article', { name: 'Project' })
  fireEvent.drop(target, { dataTransfer: transfer('text/plain', 'native-session') })
  fireEvent.drop(target, { dataTransfer: transfer(PROJECT_DRAG_TYPE, '{bad') })
  const nativeTransfer = { ...transfer(NATIVE_SIDEBAR_DRAG_TYPE, '{}'), effectAllowed: 'copy' }
  fireEvent.dragOver(target, { dataTransfer: nativeTransfer }); assert.equal(nativeTransfer.dropEffect, 'copy'); fireEvent.dragLeave(target)
  assert.deepEqual(joined, [])
  const membershipId = '11111111-1111-4111-8111-111111111111'
  const tracked = { kind: 'tracked', sessionId: 's', membershipId, metadataRevision: 3, serviceId: '22222222-2222-4222-8222-222222222222', binding: { sessionId: 's', membershipId, expectedMetadataRevision: 3, expectedLifecycleRevision: 4, expectedWorkflowRevision: 5, episodeId: 'old-round' } }
  const trackedTransfer = { ...transfer(PROJECT_DRAG_TYPE, JSON.stringify(tracked)), effectAllowed: 'move' }
  fireEvent.dragOver(target, { dataTransfer: trackedTransfer }); assert.equal(trackedTransfer.dropEffect, 'move')
  fireEvent.drop(target, { dataTransfer: transfer(PROJECT_DRAG_TYPE, JSON.stringify(tracked)) })
  fireEvent.drop(target, { dataTransfer: transfer(NATIVE_SIDEBAR_DRAG_TYPE, JSON.stringify({ version: 1, sessionId: 'native', displayTitle: 'Native' })) })
  assert.deepEqual(joined, [[tracked, 'p'], [{ kind: 'sidebar', sessionId: 'native', displayTitle: 'Native' }, 'p']])
})

test('a facet chip or its inline panel is never the card toggle', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Project')]
  board.cards = [card('one', 'p')]
  render(localized(React.createElement(ProjectOverview, {
    board, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {},
    facets: () => React.createElement(React.Fragment, null,
      React.createElement('span', { className: 'sd-facet' }, '★ 2'),
      React.createElement('div', { className: 'sd-facet-panel' }, 'panel body')),
  }), 'en'))
  const article = screen.getByRole('article', { name: 'Project' })
  assert.equal(article.getAttribute('data-expanded'), 'true', 'projects start expanded')
  fireEvent.click(article.querySelector('.sd-facet'))
  assert.equal(article.getAttribute('data-expanded'), 'true', 'a static chip is not the card toggle')
  fireEvent.click(article.querySelector('.sd-facet-panel'))
  assert.equal(article.getAttribute('data-expanded'), 'true', 'a panel rendered inline is not the card toggle either')
  fireEvent.click(article.querySelector('.sd-projectcard-head'))
  assert.equal(article.getAttribute('data-expanded'), null, 'the card head still collapses the card')
})

test('each project expands independently; Escape collapses the focused expansion and session rows keep it open', () => {
  const board = emptyBoard()
  board.projects = [{ ...project('p', 'Alpha'), tagIds: ['t1'] }, project('q', 'Beta'), project('r', 'Empty')]
  board.tags = [label('t1', 'Shared')]
  board.cards = [card('alpha-one', 'p', { membershipId: '11111111-1111-4111-8111-111111111111' }), card('alpha-two', 'p', { membershipId: '22222222-2222-4222-8222-222222222222' }), card('beta-one', 'q', { membershipId: '33333333-3333-4333-8333-333333333333' })]
  const opened = [], sessions = []
  render(localized(React.createElement(ProjectOverview, { board, onOpen: id => opened.push(id), onOpenSession: current => sessions.push(current.sessionId), onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} }), 'en'))
  const alpha = screen.getByRole('article', { name: 'Alpha' }), beta = screen.getByRole('article', { name: 'Beta' }), empty = screen.getByRole('article', { name: 'Empty' })
  const alphaToggle = within(alpha).getByRole('button', { name: 'Alpha' }), betaToggle = within(beta).getByRole('button', { name: 'Beta' })
  const stats = element => [...element.querySelectorAll('.sd-projectstats > b')].map(node => node.textContent)
  // all three start expanded, each inside its own card
  assert.equal(document.querySelectorAll('.sd-projectdrop').length, 3)
  for (const [article, label] of [[alpha, 'Alpha'], [beta, 'Beta'], [empty, 'Empty']]) {
    const region = within(article).getByRole('region')
    assert.equal(region.parentElement === article, true, `${label} keeps its sessions area inside its own card`)
    assert.equal(region.getAttribute('tabindex'), '-1')
    assert.equal(region.style.position, '')
  }
  assert.equal(within(alpha).getByRole('region', { name: 'Alpha · 2 sessions' }).querySelectorAll('.sd-projectrow').length, 2)
  assert.ok(within(alpha).getByText('alpha-one')); assert.ok(within(alpha).getByText('alpha-two'))
  assert.deepEqual([...within(within(alpha).getByRole('region')).getByLabelText('Project tags').querySelectorAll('.sd-tag')].map(node => node.textContent), ['Shared'])
  // collapsing one project leaves the others expanded
  fireEvent.click(alphaToggle)
  assert.equal(alphaToggle.getAttribute('aria-expanded'), 'false'); assert.ok(!within(alpha).queryByRole('region'))
  assert.equal(within(beta).getByRole('region', { name: 'Beta · 1 sessions' }).isConnected, true)
  fireEvent.click(alphaToggle)
  assert.equal(within(alpha).getByRole('region', { name: 'Alpha · 2 sessions' }).isConnected, true)
  // Escape inside the expansion collapses that project and returns focus to its title
  const alphaRegion = within(alpha).getByRole('region')
  fireEvent.keyDown(alphaRegion, { key: 'Escape' })
  assert.ok(!within(alpha).queryByRole('region'))
  assert.equal(document.activeElement === alphaToggle, true)
  assert.equal(within(beta).getByRole('region').isConnected, true, 'Escape only collapses the project it was pressed in')
  fireEvent.click(alphaToggle)
  // opening a session keeps the expansion in place
  fireEvent.click(within(within(alpha).getByRole('region')).getByRole('button', { name: 'alpha-one' }))
  assert.deepEqual(sessions, ['alpha-one']); assert.deepEqual(opened, [])
  assert.equal(within(alpha).getByRole('region', { name: 'Alpha · 2 sessions' }).isConnected, true)
  assert.equal(within(alpha).getByRole('region').isConnected, true, 'the row title preview leaves the expansion untouched')
  // stats and the per-project menu remain independent of the expansion
  assert.deepEqual(stats(alpha), ['2 sessions', '0 awaiting review', '0 need action'])
  assert.deepEqual(stats(empty), ['0 sessions', '0 awaiting review', '0 need action'])
  assert.ok(within(within(alpha).getByRole('region')).getByLabelText('Project tags'), 'tags live in the expansion footer')
  fireEvent.click(within(alpha).getByRole('button', { name: 'Project actions: Alpha' }))
  assert.ok(within(alpha).getByRole('button', { name: 'New session' }))
  assert.ok(within(alpha).getByRole('button', { name: 'Edit project' }))
  assert.ok(within(alpha).getByRole('button', { name: 'Delete project' }))
  assert.equal(within(alpha).getByRole('region').isConnected, true, 'the action menu and the expansion are independent')
})

test('project session rows keep details in the row menu while the title still previews', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.cards = [card('row-one', 'p')]
  const previewed = [], detailed = []
  render(localized(React.createElement(ProjectOverview, {
    board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {},
    onPreviewSession: current => previewed.push(current.sessionId),
    rowActions: { onTitle: async () => ({ ok: true }), onArchive: async () => ({ ok: true }), onFork: async () => ({ ok: true }), onDetails: current => detailed.push(current.sessionId), report() {} },
  }), 'en'))
  const row = document.querySelector('.sd-projectrow')
  assert.ok(row)
  assert.equal(row.querySelector('.sd-projectrow-actions'), null, 'the bottom action row is removed')
  assert.equal(row.querySelectorAll('button').length, 2, 'the row keeps only its title and menu trigger')
  fireEvent.click(within(row).getByRole('button', { name: 'row-one' }))
  assert.deepEqual(previewed, ['row-one'], 'the title still opens the preview')
  assert.deepEqual(detailed, [], 'the title never opens details')
  fireEvent.click(within(row).getByRole('button', { name: 'Session row actions: row-one' }))
  const menu = document.querySelector('.sd-pop')
  const details = within(menu).getByRole('button', { name: 'Session details' })
  assert.ok(details.classList.contains('sd-menu-item'), 'the new entry reuses the menu item style')
  assert.equal(menu.querySelector('button').textContent, 'Session details', 'details is the first menu entry')
  fireEvent.click(details)
  assert.deepEqual(detailed, ['row-one'], 'details open from the row menu')
})

test('project session rows omit the details entry when no details handler is supplied', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.cards = [card('row-one', 'p')]
  render(localized(React.createElement(ProjectOverview, {
    board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {},
    rowActions: { onTitle: async () => ({ ok: true }), onArchive: async () => ({ ok: true }), onFork: async () => ({ ok: true }), report() {} },
  }), 'en'))
  fireEvent.click(screen.getByRole('button', { name: 'Session row actions: row-one' }))
  const menu = screen.getByRole('group', { name: 'Session row actions: row-one' })
  assert.equal(within(menu).queryByRole('button', { name: 'Session details' }), null)
  assert.ok(within(menu).getByRole('button', { name: 'Edit title' }), 'the other row actions are unchanged')
})

test('a project row resizes from its right rail and remembers the height locally', () => {
  window.localStorage.clear()
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.cards = [card('s1', 'p')]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const handle = screen.getByRole('button', { name: '拖动调整本行高度；也可用上下方向键' })
  const row = document.querySelector('[data-project-row="0"]')
  assert.equal(row.getAttribute('data-row-height'), null, 'untouched rows keep the CSS default')
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  assert.equal(row.getAttribute('data-row-height'), '324')
  assert.equal(row.style.getPropertyValue('--sd-row-drop-height'), '324px')
  assert.deepEqual(JSON.parse(window.localStorage.getItem('session-dashboard.row-heights')), { p: 324 })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  assert.equal(row.getAttribute('data-row-height'), '300')
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  assert.equal(row.getAttribute('data-row-height'), '160', 'the row height stays inside its usable range')
})

test('new empty project saves exact fields; uncreated tag draft blocks silent project submission and close', async () => {
  const board = emptyBoard(); board.tags = [label('t', 'Shared')]
  const f = editFixture(board, null)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'First' } }); fireEvent.click(screen.getByLabelText('Shared'))
  fireEvent.change(screen.getByLabelText('新标签名称'), { target: { value: 'uncreated' } })
  assert.equal(screen.getByRole('button', { name: '创建项目' }).disabled, true)
  fireEvent.keyDown(document, { key: 'Escape' }); assert.ok(screen.getByRole('button', { name: '继续编辑' })); assert.equal(f.closed, 0)
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' })); fireEvent.change(screen.getByLabelText('新标签名称'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  await waitFor(() => assert.equal(f.closed, 1))
  assert.deepEqual(f.calls, [{ type: 'create_project', name: 'First', color: null, tagIds: ['t'] }])
})

test('project edit failure and concurrent revision changes retain input and require explicit latest reload', async () => {
  const board = emptyBoard(); board.projects = [project('p', 'Original', 7)]
  const f = editFixture(board); f.fail = true
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Local draft' } }); fireEvent.click(screen.getByRole('button', { name: '保存项目' }))
  await screen.findByText('操作未成功，输入仍保留。请重新核对后重试。')
  assert.equal(screen.getByLabelText('项目名称').value, 'Local draft'); assert.equal(f.calls[0].expectedProjectRevision, 7)
  const changed = structuredClone(board); changed.projects[0].name = 'Remote'; changed.projects[0].revision = 8; f.update(changed)
  assert.equal(screen.getByLabelText('项目名称').value, 'Local draft'); assert.equal(screen.getByRole('button', { name: '保存项目' }).disabled, true)
  fireEvent.click(screen.getByRole('button', { name: '放弃项目编辑并载入最新内容' }))
  assert.equal(screen.getByLabelText('项目名称').value, 'Remote')
})

test('the project editor owns name, colour and tags only; status management moved to the board-wide dialog', async () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project', 5)]
  const f = editFixture(board)
  assert.equal(screen.queryByLabelText('状态名称'), null, 'the project editor no longer manages statuses')
  assert.equal(screen.queryByRole('button', { name: /编辑状态|新建状态|停用状态/ }), null)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Project next' } })
  fireEvent.change(screen.getByLabelText('项目颜色'), { target: { value: '#123456' } })
  fireEvent.click(screen.getByRole('button', { name: '保存项目' }))
  await waitFor(() => assert.equal(f.calls.length, 1))
  assert.deepEqual(f.calls.map(command => command.type), ['update_project'])
  assert.equal(screen.queryByRole('alert', { name: /服务/ }), null)
  assert.equal(f.calls[0].expectedProjectRevision, 5)
  assert.equal(f.calls[0].name, 'Project next'); assert.equal(f.calls[0].color, '#123456')
})

test('tag creation is explicit and project save later includes the selected tag without touching sessions', async () => {
  const board = emptyBoard(); const f = editFixture(board, null)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Project' } }); fireEvent.change(screen.getByLabelText('新标签名称'), { target: { value: 'Shared new' } })
  fireEvent.click(screen.getByRole('button', { name: '创建标签并选中' }))
  await waitFor(() => assert.equal(screen.getByLabelText('新标签名称').value, ''))
  assert.equal(screen.getByLabelText('Shared new').checked, true)
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  await waitFor(() => assert.equal(f.closed, 1))
  assert.equal(f.calls[0].type, 'create_label'); assert.equal(f.calls[0].dimension, 'tag'); assert.deepEqual(f.calls[1].tagIds, ['new-tag'])
  assert.equal(f.calls.some(command => ['edit_card', 'move_project', 'review'].includes(command.type)), false)
})

test('project and tag writes stay bound to the opening service even after new-service acknowledgment', async () => {
  const changedService = '33333333-3333-4333-8333-333333333333'
  const newBoard = emptyBoard(); const created = editFixture(newBoard, null)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Old service draft' } })
  created.client.serviceId = changedService
  fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
  await screen.findByText(/此编辑仍属于打开时的旧服务/)
  assert.deepEqual(created.calls, []); assert.equal(screen.getByLabelText('项目名称').value, 'Old service draft')
  cleanup()
  const board = emptyBoard(); board.projects = [project('p', 'Project', 3)]
  const edited = editFixture(board)
  edited.client.serviceId = changedService
  fireEvent.change(screen.getByLabelText('新标签名称'), { target: { value: 'Old tag draft' } }); fireEvent.click(screen.getByRole('button', { name: '创建标签并选中' }))
  assert.deepEqual(edited.calls, []); assert.equal(screen.getByLabelText('新标签名称').value, 'Old tag draft')
})

test('modal focuses the project name and retains focus through Tab/Escape without discarding input', () => {
  const board = emptyBoard(); const f = editFixture(board, null)
  const name = screen.getByLabelText('项目名称'); assert.equal(document.activeElement, name)
  fireEvent.change(name, { target: { value: 'Keep' } }); fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(name.value, 'Keep'); assert.equal(f.closed, 0)
  fireEvent.click(screen.getByRole('button', { name: '放弃并关闭' })); assert.equal(f.closed, 1)
})

test('project rows always expose the status menu; idle jumps directly and pending review uses acceptance', () => {
  const board = emptyBoard()
  board.projects = [project('p', 'Alpha')]; board.statuses = [status('doing', 'Doing')]; board.orders.status.ids.push('doing')
  board.cards = [
    card('accepted', 'p', { status: 'accepted', decision: { kind: 'accepted', episodeId: 'round-1', at: 1 }, placement: { kind: 'builtin', status: 'accepted' }, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'round-1', attention: 'none' } }),
    card('idle', 'p', { placement: { kind: 'unset' }, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'not_started', episodeId: null, episodeOrder: 0, attention: 'none' } }),
    card('busy', 'p', { placement: { kind: 'custom', statusId: 'doing' }, status: 'pending_review', runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'running', episodeId: 'round-1', attention: 'none' } }),
    card('review', 'p', { status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'round-2', attention: 'none' } }),
  ]
  const changed = [], reviewed = []
  render(React.createElement(ProjectOverview, {
    board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {},
    onChangeState: (current, stateId) => changed.push([current.sessionId, stateId]),
    onReviewState: (current, stateId) => reviewed.push([current.sessionId, stateId]),
    pendingJoins: [{ token: 'join-1', sessionId: 'pending', projectId: 'p', title: 'Pending session', phase: 'joining' }],
  }))
  const region = screen.getByRole('region', { name: 'Alpha · 4 个会话' })
  assert.ok(within(region).getByText('Pending session'))
  assert.ok(within(region).getByText('正在加入项目…'))
  const busy = within(region).queryByRole('button', { name: '更改状态：busy' })
  assert.equal(busy, null, 'a running card has no state menu; its static face explains why')
  const busyFace = within(region).getByTitle('当前不可更改状态；运行中请等本轮结束')
  assert.match(busyFace.textContent, /Doing/, 'the current custom status stays visible while running')
  const choose = (sessionId, option) => {
    fireEvent.click(within(region).getByRole('button', { name: `更改状态：${sessionId}` }))
    fireEvent.click(within(region).getByRole('option', { name: option }))
  }
  choose('accepted', 'Doing'); choose('idle', 'Doing')
  assert.deepEqual(changed, [['accepted', 'doing'], ['idle', 'doing']])
  choose('review', 'Doing')
  assert.deepEqual(reviewed, [['review', 'doing']], 'pending review routes through the acceptance dialog')
  assert.deepEqual(changed, [['accepted', 'doing'], ['idle', 'doing']], 'pending review never calls choose_state directly')
})

test('a session row no longer paints its own agent chip: the host facet strip owns that fact', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  board.cards = [card('busy', 'p', { runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, attention: 'none', activeAgents: 2 } })]
  render(localized(React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onNewSession() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} })))
  const projectCard = screen.getByRole('article', { name: 'Project' })
  assert.equal(within(projectCard).queryByText('2 个子 Agent', { exact: true }), null, 'the count comes from the facet the host supplies, never from a second chip')
})

test('the project card offers New session only when the host can create one, and disables it while busy', async () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]
  const create = id => React.createElement(ProjectOverview, { board, onOpen() {}, onCreate() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {}, ...id })
  const view = render(localized(create({}), 'en'))
  const actions = screen.getByRole('button', { name: 'Project actions: Project' })
  fireEvent.click(actions)
  assert.equal(within(await screen.findByRole('group', { name: 'Project actions: Project' })).queryByRole('button', { name: 'New session' }), null, 'without a host creation path the entry is absent')
  fireEvent.click(actions)
  await waitFor(() => assert.equal(screen.queryByRole('group', { name: 'Project actions: Project' }), null))
  view.rerender(localized(create({ onNewSession() {}, newSessionBusy: true }), 'en'))
  fireEvent.click(screen.getByRole('button', { name: 'Project actions: Project' }))
  const panel = await screen.findByRole('group', { name: 'Project actions: Project' })
  assert.equal(within(panel).getByRole('button', { name: 'New session' }).disabled, true, 'one creation at a time')
})

test('a stopped run shows 已停止 on the row chip while the stored status stays in progress', () => {
  const board = emptyBoard(); board.projects = [project('p', 'Project')]; board.orders.project.ids = ['p', '__none__']
  board.cards = [card('stopped', 'p', {
    placement: { kind: 'builtin', status: 'in_progress' },
    runtime: { ...unknownRuntime(), sync: 'synced', phase: 'interrupted', episodeId: 'round-1', sourceLive: true, attention: 'interrupted', explanation: '用户已停止当前执行；本轮没有正常完成，不能验收', turnEnd: { kind: 'aborted', cause: 'user' } },
  })]
  render(React.createElement(ProjectOverview, { board, onOpen() {}, onOpenSession() {}, onCreate() {}, onEdit() {}, onDelete() {}, onReorder() {}, onJoin() {} }))
  const row = screen.getByRole('article', { name: 'Project' })
  const chip = row.querySelector('.sd-projectrow .sd-status')
  assert.equal(chip.textContent.includes('已停止'), true, 'the system outcome replaces the contradicted 进行中 label')
  assert.equal(chip.textContent.includes('进行中'), false)
  assert.match(chip.getAttribute('title'), /看板状态仍为进行中/)
  assert.equal(chip.style.getPropertyValue('--sd-chip-color'), 'var(--sd-danger)')
  assert.equal(row.querySelector('.sd-projectrow .sd-attentioninline'), null, 'the row does not repeat the same outcome')
  assert.equal(board.cards[0].status, 'in_progress', 'the stored status is untouched')
  assert.deepEqual(board.cards[0].placement, { kind: 'builtin', status: 'in_progress' })
})
