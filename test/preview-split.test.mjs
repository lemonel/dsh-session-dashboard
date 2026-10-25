import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { TranscriptDialog, PREVIEW_CONFIRM_MS, sessionOpenSource } from '../lib/frontend/TranscriptDialog.js'
import { StaticLocaleProvider } from '../lib/frontend/i18n.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { cleanup, fireEvent, render, screen, act } = await import('@testing-library/react')
const { previewCenter } = await import('../lib/frontend/completions.js')
afterEach(() => { cleanup(); document.body.replaceChildren(); previewCenter.close() })
const localized = child => React.createElement(StaticLocaleProvider, { active: 'zh' }, child)

function renderDialog(request, handlers = {}) {
  return render(localized(React.createElement(TranscriptDialog, {
    request,
    onClose: handlers.onClose ?? (() => {}),
    onDetails: handlers.onDetails,
    onCloseSplit: handlers.onCloseSplit ?? (() => {}),
    onStartSplit: handlers.onStartSplit,
    onCancelSplit: handlers.onCancelSplit,
  })))
}

/** The frame-level preview host: the real TranscriptDialog bound to the real
 *  PreviewCenter, so a pick is driven through the same open()/beginSplit() path
 *  the dashboard and toast use. */
function PreviewHost({ onClose = () => previewCenter.close() } = {}) {
  const request = React.useSyncExternalStore(previewCenter.subscribe, previewCenter.getSnapshot, previewCenter.getSnapshot)
  return React.createElement(TranscriptDialog, {
    request,
    onClose,
    onCloseSplit: () => previewCenter.closeSplit(),
    onStartSplit: () => previewCenter.beginSplit(),
    onCancelSplit: () => previewCenter.cancelSplit(),
  })
}
const pickBar = () => document.querySelector('.sd-split-pickbar')
const cacheOverlay = () => document.querySelector('[data-preview-cache]')
const pickButton = () => screen.getByRole('button', { name: '并排打开另一个会话', exact: true })

const previewEnterLinks = () => [...document.querySelectorAll('a.sd-preview-enter')]

function stateFixture() {
  const board = emptyBoard()
  board.projects = [{ id: 'p', name: '项目', color: null, createdAt: 1, revision: 2, tagIds: [] }]
  board.statuses = [{ id: 's1', name: '开发中', color: null, createdAt: 1, revision: 0 }]
  board.orders.status.ids.push('s1')
  const card = {
    sessionId: 'a', membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null },
    hostTitle: '会话 A', titleOverride: null, workspace: '/w', projectId: 'p', tagIds: [], progress: '',
    status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null, workflowRevision: 2,
    runtime: { ...unknownRuntime(), sync: 'synced', phase: 'not_started', sourceLive: true, attention: 'none' },
    decision: null, joinedAt: 1, activityAt: 2, updatedAt: 2, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 1, lifecycleRevision: 1,
  }
  board.cards = [card]
  return { board, card }
}

test('the preview hosts two independent native frames when a second pane is requested', () => {
  renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } })
  const panes = document.querySelectorAll('.sd-preview-pane')
  assert.equal(panes.length, 2, 'both panes are rendered side by side')
  assert.equal(document.querySelector('.sd-preview-panes')?.getAttribute('data-panes'), '2')
  const sources = [...document.querySelectorAll('iframe.sd-native-page')].map(node => node.getAttribute('src'))
  assert.equal(sources.length, 2)
  assert.notEqual(sources[0], sources[1], 'each pane boots its own client at its own Session')
  assert.ok(sources[0]?.includes('session-dashboard-preview=a'))
  assert.ok(sources[1]?.includes('session-dashboard-preview=b'))
  assert.deepEqual([...document.querySelectorAll('.sd-preview-pane-head h2')].map(node => node.textContent), ['会话 A', '会话 B'])
})

test('the single preview head opens the complete native page in a new browser tab', () => {
  renderDialog({ sessionId: 'a', title: '会话 A' })
  const links = previewEnterLinks()
  assert.equal(links.length, 1, 'the head exposes exactly one new-tab link')
  assert.equal(links[0].getAttribute('target'), '_blank')
  assert.match(links[0].getAttribute('rel') ?? '', /noopener/)
  assert.equal(links[0].textContent, '在新标签打开会话核对结果 ↗')
  const href = new URL(links[0].getAttribute('href'))
  assert.equal(href.searchParams.get('session-dashboard-open'), 'a')
  assert.equal(href.searchParams.get('session-dashboard-preview'), null, 'the frame-only preview marker never leaks into the new tab')
  assert.equal(href.origin, window.location.origin, 'the current host origin is reused instead of a hard-coded one')
})

test('both side-by-side panes link to their own native tab', () => {
  renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } })
  const links = previewEnterLinks()
  assert.equal(links.length, 2, 'each window carries its own link')
  for (const link of links) {
    assert.equal(link.getAttribute('target'), '_blank')
    assert.match(link.getAttribute('rel') ?? '', /noopener/)
  }
  const targets = links.map(link => new URL(link.getAttribute('href')).searchParams.get('session-dashboard-open'))
  assert.deepEqual(targets, ['a', 'b'])
  for (const link of links) assert.equal(new URL(link.getAttribute('href')).searchParams.get('session-dashboard-preview'), null)
})

test('the enter action is a plain browser link, not an in-page navigation callback', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A' }, { onClose: () => { closed += 1 } })
  const link = previewEnterLinks()[0]
  // Keep jsdom from trying to navigate; a React handler would still run before this.
  link.addEventListener('click', event => event.preventDefault(), { once: true })
  fireEvent.click(link)
  assert.equal(closed, 0, 'the link neither closes the preview nor runs an old enter callback')
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1, 'the current page keeps the preview open')
})

test('the new-tab helper keeps host parameters and drops the preview marker', () => {
  window.history.replaceState({}, '', '/?token=host-token&session-dashboard-preview=a')
  try {
    const url = new URL(sessionOpenSource('b'))
    assert.equal(url.searchParams.get('token'), 'host-token', 'other host parameters such as a token are preserved')
    assert.equal(url.searchParams.get('session-dashboard-open'), 'b')
    assert.equal(url.searchParams.get('session-dashboard-preview'), null, 'a URL carrying both markers opens the native page only')
  } finally { window.history.replaceState({}, '', '/') }
})

test('closing the second pane reports back to the preview owner', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } }, { onCloseSplit: () => { closed += 1 } })
  fireEvent.click(screen.getByRole('button', { name: '关闭这个窗格' }))
  assert.equal(closed, 1)
})

test('a single-session preview keeps one pane and one frame', () => {
  renderDialog({ sessionId: 'a', title: '会话 A' })
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1)
  assert.equal(document.querySelectorAll('iframe.sd-native-page').length, 1)
  assert.equal(document.querySelector('.sd-preview-panes')?.getAttribute('data-panes'), '1')
})

test('closing the floating window keeps only the primary client cached', () => {
  const view = renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } })
  assert.equal(document.querySelectorAll('iframe.sd-native-page').length, 2)
  view.rerender(localized(React.createElement(TranscriptDialog, { request: null, onClose: () => {}, onCloseSplit: () => {} })))
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1, 'the side-by-side pane never outlives the open window')
  const frames = [...document.querySelectorAll('iframe.sd-native-page')]
  assert.equal(frames.length, 1)
  assert.ok(frames[0].getAttribute('src')?.includes('session-dashboard-preview=a'), 'the primary stays cached while hidden')
  assert.equal(document.querySelector('[data-preview-cache]')?.hidden, true)
})

test('the window head shows the live placement and changes it like a project row', async () => {
  const { board, card } = stateFixture()
  const changes = []
  const source = {
    subscribe: () => () => {},
    read: () => ({ board, card }),
    onChangeState: (_card, stateId) => { changes.push(stateId) },
    onReviewState: () => {},
  }
  renderDialog({ sessionId: 'a', title: '会话 A', state: source })
  const trigger = screen.getByRole('button', { name: '更改状态：会话 A' })
  assert.match(trigger.textContent, /进行中/, 'the real built-in status stays visible')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: '开发中' }))
  assert.deepEqual(changes, ['s1'], 'picking a state runs the same choose_state path as a project row')
})

test('a preview without a tracked card has no status control', () => {
  renderDialog({ sessionId: 'a', title: '会话 A' })
  assert.equal(screen.queryByRole('button', { name: /^更改状态：/ }), null)
})

test('the preview gives the frame back after two seconds and never reloads a mismatched frame', async () => {
  assert.equal(PREVIEW_CONFIRM_MS, 2_000, 'the parent waits exactly as long as the frame reconciles')
  renderDialog({ sessionId: 'a', title: '会话 A' })
  const frame = document.querySelector('iframe.sd-native-page')
  const wrap = document.querySelector('.sd-native-page-wrap')
  assert.equal(wrap?.hasAttribute('data-preview-pending'), true, 'an unconfirmed frame stays hidden during startup')

  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_300)) })
  assert.equal(document.querySelector('iframe.sd-native-page'), frame, 'the native client is never remounted at the deadline')
  assert.equal(wrap?.hasAttribute('data-preview-pending'), false, 'the frame is visible even when confirmation never arrived')
  assert.match(document.querySelector('.sd-transcript-state')?.textContent ?? '', /未能确认目标会话/)

  // A late frame confirmation clears the warning without any navigation, and
  // a subagent report cannot turn the frame back into the requested Session.
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'session-dashboard-preview-change', sessionId: 'a' },
      origin: window.location.origin,
    }))
  })
  assert.equal(document.querySelector('.sd-transcript-state'), null, 'the late confirmation clears the warning')
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'session-dashboard-preview-change', sessionId: 'subagent' },
      origin: window.location.origin,
    }))
  })
  assert.equal(document.querySelector('.sd-transcript-state'), null, 'a subagent report does not re-hide or reload the frame')

  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_000)) })
  assert.equal(document.querySelector('iframe.sd-native-page'), frame, 'the old 2.5s mismatch reload is gone')
  assert.equal(wrap?.hasAttribute('data-preview-pending'), false)
})

test('pressing the mask closes the floating window', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A' }, { onClose: () => { closed += 1 } })
  fireEvent.mouseDown(document.querySelector('.sd-overlay'))
  assert.equal(closed, 1)
})

test('a press inside the window, its iframe or its controls never closes it', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A' }, { onClose: () => { closed += 1 } })
  const pane = document.querySelector('.sd-preview-pane')
  fireEvent.mouseDown(pane)
  fireEvent.mouseDown(document.querySelector('iframe.sd-native-page'))
  fireEvent.mouseDown(screen.getByRole('button', { name: '刷新', exact: true }))
  fireEvent.mouseDown(document.querySelector('.sd-native-page-wrap'))
  assert.equal(closed, 0)
})

test('the gap between two windows is deck, not mask, so it does not close them', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } }, { onClose: () => { closed += 1 } })
  const panes = document.querySelectorAll('.sd-preview-pane')
  assert.equal(panes.length, 2)
  for (const pane of panes) fireEvent.mouseDown(pane)
  fireEvent.mouseDown(document.querySelector('.sd-preview-deck'))
  assert.equal(closed, 0, 'a press on the deck itself is still inside the floating window')
  fireEvent.mouseDown(document.querySelector('.sd-overlay'))
  assert.equal(closed, 1, 'the mask still closes both windows')
})

test('Escape still closes the floating window', () => {
  let closed = 0
  renderDialog({ sessionId: 'a', title: '会话 A' }, { onClose: () => { closed += 1 } })
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(closed, 1)
})

test('only a lone primary pane offers the pick entry', () => {
  let started = 0
  renderDialog({ sessionId: 'a', title: '会话 A' }, { onStartSplit: () => { started += 1 } })
  fireEvent.click(pickButton())
  assert.equal(started, 1, 'the primary head starts the pick')
})

test('a side-by-side deck and a host without the pick handler show no pick entry', () => {
  renderDialog({ sessionId: 'a', title: '会话 A', split: { sessionId: 'b', title: '会话 B' } }, { onStartSplit: () => {} })
  assert.equal(screen.queryByRole('button', { name: '并排打开另一个会话' }), null, 'an existing split leaves no room for a third pane')
  cleanup()
  renderDialog({ sessionId: 'a', title: '会话 A' })
  assert.equal(screen.queryByRole('button', { name: '并排打开另一个会话' }), null, 'the entry only exists where a host can start a pick')
})

test('the head picks a second pane while the deck hides and the primary client stays mounted', () => {
  render(localized(React.createElement(PreviewHost)))
  act(() => previewCenter.open({ sessionId: 'a', title: '会话 A' }))
  const primaryFrame = document.querySelector('iframe.sd-native-page')
  assert.ok(primaryFrame?.getAttribute('src')?.includes('session-dashboard-preview=a'))
  assert.equal(cacheOverlay()?.hidden, false)

  fireEvent.click(pickButton())
  assert.equal(cacheOverlay()?.hidden, true, 'the deck hides instead of staying on top of the dashboard')
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1, 'the primary pane is not destroyed')
  assert.equal(document.querySelector('iframe.sd-native-page'), primaryFrame, 'the cached native client keeps its DOM node')
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'a', 'picking leaves the original request alone')
  assert.ok(pickBar(), 'a light prompt explains the pick and how to cancel')
  assert.match(pickBar().textContent, /请选择另一个会话来并排/)
  assert.equal(document.querySelector('.sd-preview-deck')?.getAttribute('data-sd-dialog'), null, 'a hidden deck is not the topmost dialog')

  act(() => previewCenter.open({ sessionId: 'b', title: '会话 B' }))
  assert.equal(cacheOverlay()?.hidden, false, 'choosing restores the deck')
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 2)
  assert.equal(document.querySelector('.sd-preview-panes')?.getAttribute('data-panes'), '2')
  const sources = [...document.querySelectorAll('iframe.sd-native-page')].map(node => node.getAttribute('src'))
  assert.ok(sources[0]?.includes('session-dashboard-preview=a'), 'the original Session stays on the left')
  assert.ok(sources[1]?.includes('session-dashboard-preview=b'), 'the picked Session loads as the temporary second pane')
  assert.equal(pickBar(), null, 'the pick prompt is gone once the pane exists')
  assert.deepEqual(previewCenter.getSnapshot()?.split, { sessionId: 'b', title: '会话 B' })

  fireEvent.click(screen.getByRole('button', { name: '关闭这个窗格' }))
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1, 'closing the side pane destroys only it')
  const frames = document.querySelectorAll('iframe.sd-native-page')
  assert.equal(frames.length, 1)
  assert.equal(frames[0], primaryFrame, 'the primary client is still the cached one')
  assert.equal(previewCenter.getSnapshot()?.split, null)
})

test('cancel and Escape end a pick without touching the open preview', () => {
  render(localized(React.createElement(PreviewHost)))
  act(() => previewCenter.open({ sessionId: 'a', title: '会话 A' }))
  const frame = document.querySelector('iframe.sd-native-page')

  fireEvent.click(pickButton())
  fireEvent.click(screen.getByRole('button', { name: '取消并排选择', exact: true }))
  assert.equal(previewCenter.getSnapshot()?.picking, undefined, 'cancelling removes the pick marker')
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'a', 'the original request is unchanged')
  assert.equal(cacheOverlay()?.hidden, false, 'the preview comes back')
  assert.equal(document.querySelector('iframe.sd-native-page'), frame)

  fireEvent.click(pickButton())
  assert.equal(cacheOverlay()?.hidden, true)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(previewCenter.getSnapshot()?.picking, undefined, 'Escape cancels the pick instead of closing the preview')
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'a')
  assert.equal(cacheOverlay()?.hidden, false)
  assert.equal(document.querySelectorAll('.sd-preview-pane').length, 1)

  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(previewCenter.getSnapshot(), null, 'a later Escape closes the restored preview normally')
})

test('the preview center only splits on an explicit pick and keeps the toast path', () => {
  const base = { sessionId: 'a', title: '会话 A' }
  previewCenter.open(base)
  previewCenter.beginSplit()
  assert.deepEqual(previewCenter.getSnapshot(), { ...base, picking: true })
  // Picking the primary again would duplicate it: that press just ends the pick.
  previewCenter.open({ sessionId: 'a', title: '会话 A' })
  assert.deepEqual(previewCenter.getSnapshot(), base)

  previewCenter.beginSplit()
  previewCenter.cancelSplit()
  assert.deepEqual(previewCenter.getSnapshot(), base, 'cancel restores the request exactly')
  assert.equal(previewCenter.getSnapshot()?.split, undefined)

  // A second begin with an existing split does nothing, and a toast's sideBySide
  // still splits immediately without any pick state.
  previewCenter.open({ sessionId: 'b', title: '会话 B', sideBySide: true })
  assert.deepEqual(previewCenter.getSnapshot()?.split, { sessionId: 'b', title: '会话 B' })
  previewCenter.beginSplit()
  assert.equal(previewCenter.getSnapshot()?.picking, undefined, 'a two-pane deck cannot start a pick')

  // A direct open (no sideBySide, no pick) replaces the deck as before.
  previewCenter.open({ sessionId: 'c', title: '会话 C' })
  assert.equal(previewCenter.getSnapshot()?.sessionId, 'c')
  assert.equal(previewCenter.getSnapshot()?.split, undefined)
})

