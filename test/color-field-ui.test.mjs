import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { ColorField, COLOR_PRESETS, DEFAULT_COLOR, validColor } from '../lib/frontend/ColorField.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })

function mount(value = '', extra = {}) {
  const changes = []
  const field = next => React.createElement(ColorField, { label: '项目颜色', value: next, onChange, ...extra })
  const onChange = next => { changes.push(next); mounted.rerender(field(next)) }
  const mounted = render(field(value))
  return { changes, rerender: next => mounted.rerender(field(next)) }
}

test('colour editing is a palette first: native picker, hex value, presets and an explicit clear', () => {
  const f = mount('')
  const palette = screen.getByLabelText('项目颜色 调色板')
  assert.equal(palette.tagName, 'INPUT')
  assert.equal(palette.getAttribute('type'), 'color')
  assert.equal(palette.value, DEFAULT_COLOR, 'an empty colour falls back to a valid picker value')
  const hex = screen.getByLabelText('项目颜色')
  assert.equal(hex.getAttribute('type'), 'text')
  assert.equal(hex.value, '')
  assert.equal(screen.getByRole('button', { name: '清除颜色' }).disabled, true, 'nothing to clear before a colour is chosen')
  assert.equal(screen.getByRole('group', { name: '预设颜色' }).children.length, COLOR_PRESETS.length)

  fireEvent.change(palette, { target: { value: '#123456' } })
  assert.deepEqual(f.changes, ['#123456'])
  assert.equal(screen.getByLabelText('项目颜色').value, '#123456')

  fireEvent.change(hex, { target: { value: '#abcdef' } })
  assert.equal(f.changes.at(-1), '#abcdef')
  assert.equal(screen.getByLabelText('项目颜色 调色板').value, '#abcdef')

  fireEvent.click(screen.getByRole('button', { name: '使用颜色 #2f8f63' }))
  assert.equal(f.changes.at(-1), '#2f8f63')
  assert.equal(screen.getByRole('button', { name: '使用颜色 #2f8f63' }).getAttribute('aria-pressed'), 'true')
  assert.equal(screen.getByRole('button', { name: '使用颜色 #4f63c8' }).getAttribute('aria-pressed'), 'false')

  fireEvent.click(screen.getByRole('button', { name: '清除颜色' }))
  assert.equal(f.changes.at(-1), '')
  assert.equal(screen.getByRole('button', { name: '使用颜色 #2f8f63' }).getAttribute('aria-pressed'), 'false')
})

test('invalid hex is reported next to the palette instead of silently blocking the picker', () => {
  const f = mount('#12')
  assert.ok(screen.getByText('颜色需为空或 #RRGGBB，例如 #5266c9。'))
  assert.equal(screen.getByLabelText('项目颜色 调色板').value, DEFAULT_COLOR, 'the picker keeps a valid value while the text field is invalid')
  const hex = screen.getByLabelText('项目颜色')
  assert.equal(hex.value, '#12')
  fireEvent.change(hex, { target: { value: '#2f8f63' } })
  assert.equal(f.changes.at(-1), '#2f8f63')
  assert.equal(screen.queryByText('颜色需为空或 #RRGGBB，例如 #5266c9。'), null)
})

test('a disabled colour field keeps the value visible but cannot be changed', () => {
  mount('#4f63c8', { disabled: true })
  const palette = screen.getByLabelText('项目颜色 调色板')
  const hex = screen.getByLabelText('项目颜色')
  assert.equal(palette.disabled, true)
  assert.equal(hex.disabled, true)
  assert.equal(hex.value, '#4f63c8')
  for (const preset of COLOR_PRESETS) assert.equal(screen.getByRole('button', { name: `使用颜色 ${preset}` }).disabled, true)
  assert.equal(screen.getByRole('button', { name: '清除颜色' }).disabled, true)
})

test('validColor accepts only empty or canonical six-digit hex', () => {
  for (const value of ['', '#000000', '#ffffff', '#AbCdEf']) assert.equal(validColor(value), true)
  for (const value of ['#', '#fff', '#12345', '#1234567', '123456', '#gggggg', 'red']) assert.equal(validColor(value), false)
})
