import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { completionCenter, CompletionToast, previewCenter } from '../lib/frontend/completions.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value: value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const t = key => key
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const clearNotices = () => { for (const notice of completionCenter.getSnapshot().notices) completionCenter.dismiss(notice.id); completionCenter.markRead(); previewCenter.close() }
afterEach(() => { cleanup(); document.body.replaceChildren(); clearNotices() })

async function notify(sessionId, title) { await act(async () => { completionCenter.notify(sessionId, title, title, null, null) }) }

test('several notices stack and one can be closed on its own', async () => {
  render(React.createElement(CompletionToast, { t, openPreview: () => {}, dismissAfterMs: 5000 }))
  await notify('a', 'First')
  await notify('b', 'Second')
  const toasts = screen.getAllByRole('status')
  assert.equal(toasts.length, 2)
  assert.deepEqual(toasts.map(node => node.querySelector('.sd-completion-copy p')?.textContent), ['Second', 'First'], 'newest first')
  await act(async () => { fireEvent.click(toasts[0].querySelector('button.sd-icon-btn')) })
  assert.equal(screen.getAllByRole('status').length, 1, 'closing one keeps the rest')
  assert.equal(screen.getByText('First').textContent, 'First')
})

test('hovering cancels the countdown for good, and leaving does not restart it', async () => {
  render(React.createElement(CompletionToast, { t, openPreview: () => {}, dismissAfterMs: 120 }))
  await notify('a', 'Keep me')
  const toast = screen.getByRole('status')
  await act(async () => { fireEvent.mouseEnter(toast) })
  assert.equal(toast.getAttribute('data-cancelled'), 'true')
  assert.equal(toast.querySelector('.sd-completion-track'), null, 'the cancelled toast hides its countdown bar')
  await wait(300)
  assert.equal(screen.queryByRole('status') !== null, true, 'a looked-at notice survives past the timeout')
  await act(async () => { fireEvent.mouseLeave(toast) })
  await wait(300)
  assert.equal(screen.queryByRole('status') !== null, true, 'leaving does not restart the countdown')
  await act(async () => { fireEvent.click(screen.getByRole('status').querySelector('button.sd-icon-btn')) })
  assert.equal(screen.queryByRole('status'), null, 'manual close still removes it')
})

test('an untouched notice still disappears after its delay', async () => {
  render(React.createElement(CompletionToast, { t, openPreview: () => {}, dismissAfterMs: 120 }))
  await notify('a', 'Auto close')
  assert.equal(screen.queryByRole('status') !== null, true)
  await wait(260)
  assert.equal(screen.queryByRole('status'), null)
})

test('opening the preview from a notice consumes that notice only', async () => {
  const opened = []
  render(React.createElement(CompletionToast, { t, openPreview: request => opened.push(request), dismissAfterMs: 5000 }))
  await notify('a', 'First')
  await notify('b', 'Second')
  const first = screen.getAllByRole('status').find(node => node.textContent?.includes('First'))
  const button = [...first.querySelectorAll('button')].find(node => node.textContent === 'previewSession')
  await act(async () => { fireEvent.click(button) })
  assert.deepEqual(opened, [{ sessionId: 'a', title: 'First', episodeId: null }], 'the preview still opens')
  const remaining = screen.getAllByRole('status')
  assert.equal(remaining.length, 1, 'only the clicked notice is removed')
  assert.equal(remaining[0].textContent?.includes('Second'), true)
})

test('opening the second pane also consumes the notice', async () => {
  previewCenter.open({ sessionId: 'other', title: 'Other' })
  const opened = []
  render(React.createElement(CompletionToast, { t, openPreview: request => opened.push(request), dismissAfterMs: 5000 }))
  await notify('a', 'First')
  const toast = screen.getByRole('status')
  const button = [...toast.querySelectorAll('button')].find(node => node.textContent === 'openSideBySide')
  await act(async () => { fireEvent.click(button) })
  assert.deepEqual(opened, [{ sessionId: 'a', title: 'First', episodeId: null, sideBySide: true }])
  assert.equal(screen.queryByRole('status'), null)
  assert.deepEqual(previewCenter.getSnapshot(), { sessionId: 'other', title: 'Other' }, 'dismissing a notice leaves the preview centre alone')
})
