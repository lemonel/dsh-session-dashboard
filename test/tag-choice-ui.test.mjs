import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { cardDraft } from '../lib/frontend/editor.js'
import { reviewBinding } from '../lib/frontend/view-model.js'
import { Drawer } from '../lib/frontend/Drawer.js'
import { StaticLocaleProvider } from '../lib/frontend/i18n.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })

const label = (id, name, extra = {}) => ({ id, name, color: null, createdAt: 1, revision: 0, ...extra })
function fixture(tagIds = []) {
  const board = emptyBoard()
  board.tagGroups = [label('g1', '优先级', { builtin: false })]
  board.tags = [label('hi', '高', { groupId: 'g1' }), label('lo', '低', { groupId: 'g1' }), label('loose', '临时', { groupId: null })]
  board.cards = [{ sessionId: 'a', membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null }, hostTitle: 'A', titleOverride: null, workspace: '/ws', projectId: null, tagIds: [...tagIds], progress: '', status: 'in_progress', placement: { kind: 'unset' }, origin: null, placementWitness: null, workflowRevision: 0, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, attention: 'none' }, decision: null, joinedAt: 1, activityAt: null, updatedAt: 1, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }]
  const card = board.cards[0]
  return { board, card, editor: { draft: cardDraft(card), binding: reviewBinding(card), serviceId: null }, changes: [] }
}
function show(value = []) {
  const f = fixture(value)
  let editor = f.editor, rerender = () => {}
  const view = () => React.createElement(StaticLocaleProvider, { active: 'zh' }, React.createElement(Drawer, {
    board: f.board, card: f.card, editor, busy: false, ready: true,
    onChange: draft => { f.changes.push(draft); editor = { ...editor, draft }; rerender(view()) },
    onClose() {}, onSave() {}, onReload() {}, onRebind() {}, onRebaselineSource() {}, onResync() {},
  }))
  const mounted = render(view())
  rerender = view => mounted.rerender(view)
  return f
}

test('the drawer offers one value per tag group and clears on a second click', () => {
  const f = show(['hi'])
  const group = screen.getByRole('radiogroup', { name: '优先级' })
  const [high, low] = [...group.querySelectorAll('[role=radio]')]
  assert.equal(high.getAttribute('aria-checked'), 'true')
  assert.equal(low.getAttribute('aria-checked'), 'false')
  fireEvent.click(low)
  assert.deepEqual(f.changes.at(-1).tagIds, ['lo'], 'another value in the same group replaces the first')
  fireEvent.click(low)
  assert.deepEqual(f.changes.at(-1).tagIds, [], 'clicking the selected value clears the group')
})

test('ungrouped tags are their own single slot and other groups are untouched', () => {
  const f = show(['hi', 'loose'])
  const ungrouped = screen.getByRole('radiogroup', { name: '未分组' })
  fireEvent.click(ungrouped.querySelector('[role=radio]'))
  assert.deepEqual(f.changes.at(-1).tagIds, ['hi'], 'clearing the ungrouped slot keeps the grouped value')
})
