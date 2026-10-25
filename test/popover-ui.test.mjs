import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { Popover } from '../lib/frontend/Popover.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })
const item = name => React.createElement('button', null, name)

test('a closed popover renders no panel and exposes its trigger as a collapsed disclosure', () => {
  render(React.createElement(Popover, { label: '更多操作' }, item('刷新数据'), item('已有会话候选')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  assert.equal(trigger.getAttribute('type'), 'button')
  assert.equal(trigger.getAttribute('aria-label'), '更多操作')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(trigger.getAttribute('aria-haspopup'), 'true')
  assert.equal(trigger.getAttribute('aria-controls'), null, 'aria-controls only points at a mounted panel')
  assert.equal(screen.queryByRole('group'), null, 'the panel is not rendered while closed')
  assert.equal(screen.queryByRole('button', { name: '刷新数据' }), null, 'hidden actions are unmounted, so their names cannot duplicate')
  assert.equal(screen.queryByRole('button', { name: '已有会话候选' }), null)
  const icon = trigger.querySelector('svg.sd-more')
  assert.ok(icon, 'the default trigger is the three-dot affordance')
  assert.equal(icon.getAttribute('aria-hidden'), 'true')
})

test('pressing the trigger opens a named panel, wires aria-controls and moves focus into the panel', () => {
  render(React.createElement(Popover, { label: '更多操作' }, item('刷新数据'), item('已有会话候选')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  fireEvent.click(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  const panel = screen.getByRole('group', { name: '更多操作' })
  assert.equal(trigger.getAttribute('aria-controls'), panel.id)
  assert.equal(panel.getAttribute('role'), 'group')
  assert.equal(panel.tabIndex, -1, 'the panel is focusable only programmatically')
  assert.equal(panel.getAttribute('data-align'), 'end', 'the default alignment is the trigger edge')
  assert.equal(panel.className, 'sd-pop')
  assert.equal(document.activeElement, panel, 'opening moves focus to the first control surface of the disclosure')
  assert.ok(within(panel).getByRole('button', { name: '刷新数据' }))
  assert.ok(within(panel).getByRole('button', { name: '已有会话候选' }))
  fireEvent.click(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(trigger.getAttribute('aria-controls'), null)
  assert.equal(screen.queryByRole('group'), null, 'pressing the trigger again collapses the disclosure')
})

test('a custom trigger, alignment and panel class only change presentation, not the disclosure contract', () => {
  render(React.createElement(Popover, {
    label: '筛选',
    align: 'start',
    triggerClassName: 'sd-filtertrigger',
    panelClassName: 'sd-filterpanel',
    trigger: React.createElement('span', null, '筛选'),
  }, React.createElement('label', null, React.createElement('input', { type: 'checkbox' }), React.createElement('span', null, '进行中'))))
  const trigger = screen.getByRole('button', { name: '筛选' })
  assert.equal(trigger.className, 'sd-filtertrigger')
  assert.equal(trigger.querySelector('svg.sd-more'), null, 'a custom trigger replaces the icon')
  assert.ok(trigger.textContent.includes('筛选'))
  fireEvent.click(trigger)
  const panel = screen.getByRole('group', { name: '筛选' })
  assert.equal(panel.getAttribute('data-align'), 'start')
  assert.equal(panel.className, 'sd-pop sd-filterpanel', 'the extra panel class is additive')
  assert.ok(within(panel).getByRole('checkbox', { name: '进行中' }))
})

test('Escape closes the panel, stops the event and returns focus to the trigger', () => {
  const bubbled = []
  const outer = event => bubbled.push(event.key)
  document.addEventListener('keydown', outer)
  try {
    render(React.createElement(Popover, { label: '更多操作' }, item('刷新数据')))
    const trigger = screen.getByRole('button', { name: '更多操作' })
    fireEvent.click(trigger)
    const panel = screen.getByRole('group', { name: '更多操作' })
    fireEvent.keyDown(panel, { key: 'a' })
    assert.ok(screen.getByRole('group', { name: '更多操作' }), 'only Escape collapses the disclosure')
    assert.deepEqual(bubbled, ['a'], 'ordinary keys keep bubbling normally')
    fireEvent.keyDown(panel, { key: 'Escape' })
    assert.equal(screen.queryByRole('group'), null)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, trigger, 'focus returns to the disclosure trigger')
    assert.deepEqual(bubbled, ['a'], 'the owning page or dialog must not also treat this Escape as its own')
  } finally { document.removeEventListener('keydown', outer) }
})

test('a pointerdown outside the wrapper closes the panel while one inside keeps it open', () => {
  render(React.createElement(Popover, { label: '更多操作' }, item('刷新数据')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  fireEvent.click(trigger)
  const panel = screen.getByRole('group', { name: '更多操作' })
  fireEvent.pointerDown(panel)
  assert.ok(screen.getByRole('group', { name: '更多操作' }), 'an interaction inside the panel never dismisses it')
  fireEvent.pointerDown(within(panel).getByRole('button', { name: '刷新数据' }))
  assert.ok(screen.getByRole('group', { name: '更多操作' }))
  fireEvent.pointerDown(document.body)
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
})

test('a blur that leaves the wrapper closes the panel while focus moving inside it does not', () => {
  render(React.createElement(Popover, { label: '更多操作' }, item('刷新数据'), item('已有会话候选')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  fireEvent.click(trigger)
  const panel = screen.getByRole('group', { name: '更多操作' })
  const first = within(panel).getByRole('button', { name: '刷新数据' }), second = within(panel).getByRole('button', { name: '已有会话候选' })
  first.focus()
  fireEvent.blur(first, { relatedTarget: second })
  assert.ok(screen.getByRole('group', { name: '更多操作' }), 'moving focus between panel controls keeps the disclosure open')
  fireEvent.blur(second, { relatedTarget: document.body })
  assert.equal(screen.queryByRole('group'), null, 'focus leaving the whole wrapper collapses the panel')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
})

test('a closeOnSelect action menu closes after any inner button but not after static panel content', () => {
  render(React.createElement(Popover, { label: '项目操作：Alpha', closeOnSelect: true },
    item('项目看板'), item('刷新数据'), React.createElement('p', null, '静态说明不是操作')))
  const trigger = screen.getByRole('button', { name: '项目操作：Alpha' })
  fireEvent.click(trigger)
  const panel = screen.getByRole('group', { name: '项目操作：Alpha' })
  fireEvent.click(within(panel).getByText('静态说明不是操作'))
  assert.ok(screen.getByRole('group', { name: '项目操作：Alpha' }), 'static menu copy is not an action and does not dismiss the menu')
  fireEvent.click(within(panel).getByRole('button', { name: '项目看板' }))
  assert.equal(screen.queryByRole('group'), null, 'one chosen action closes the action menu')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  fireEvent.click(trigger)
  fireEvent.click(within(screen.getByRole('group', { name: '项目操作：Alpha' })).getByRole('button', { name: '刷新数据' }))
  assert.equal(screen.queryByRole('group'), null, 'the menu is reusable after it collapsed once')
})

test('a filter panel without closeOnSelect stays open across several checkbox picks', () => {
  render(React.createElement(Popover, { label: '筛选' },
    React.createElement('label', null, React.createElement('input', { type: 'checkbox' }), React.createElement('span', null, '进行中')),
    React.createElement('label', null, React.createElement('input', { type: 'checkbox' }), React.createElement('span', null, '待验收'))))
  const trigger = screen.getByRole('button', { name: '筛选' })
  fireEvent.click(trigger)
  const panel = screen.getByRole('group', { name: '筛选' })
  const first = within(panel).getByRole('checkbox', { name: '进行中' })
  fireEvent.click(first)
  assert.equal(first.checked, true)
  assert.ok(screen.getByRole('group', { name: '筛选' }), 'picking one filter must not close the disclosure')
  fireEvent.click(within(panel).getByRole('checkbox', { name: '待验收' }))
  assert.equal(within(panel).getByRole('checkbox', { name: '待验收' }).checked, true)
  assert.ok(screen.getByRole('group', { name: '筛选' }), 'the panel survives repeated picks so several dimensions stay reachable')
  assert.equal(document.activeElement, panel, 'the panel keeps focus while it is used as a filter surface')
})

test('a disabled trigger never opens the panel', () => {
  render(React.createElement(Popover, { label: '更多操作', disabled: true }, item('刷新数据')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  assert.equal(trigger.disabled, true)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  fireEvent.click(trigger)
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(screen.queryByRole('button', { name: '刷新数据' }), null)
  trigger.click()
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
})

test('buttonRef exposes the trigger so a dialog opened from the panel can restore focus to it', () => {
  const triggerRef = React.createRef()
  render(React.createElement(Popover, { label: '更多操作', closeOnSelect: true, buttonRef: triggerRef }, item('分类与排列')))
  const trigger = screen.getByRole('button', { name: '更多操作' })
  assert.equal(triggerRef.current, trigger)
  fireEvent.click(triggerRef.current)
  fireEvent.click(within(screen.getByRole('group', { name: '更多操作' })).getByRole('button', { name: '分类与排列' }))
  assert.equal(screen.queryByRole('group'), null)
  assert.equal(triggerRef.current.isConnected, true, 'the trigger stays mounted, so returning focus to it survives the menu unmounting')
  triggerRef.current.focus()
  assert.equal(document.activeElement, triggerRef.current)
})
