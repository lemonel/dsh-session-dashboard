import test from 'node:test'
import assert from 'node:assert/strict'
import { renameNativeTitle } from '../lib/frontend/session-rename.js'

test('native rename retains the session and renames through the Client Session Controller', async () => {
  const calls = []
  const sessions = {
    using: async (target, options, operation) => {
      calls.push({ target, options })
      return operation({ binding: { session: { rename: async title => ({ ok: true, value: { title: title.trim(), seq: 7 } }) } } })
    },
  }
  assert.deepEqual(await renameNativeTitle(sessions, 'session-1', '  新标题  '), { ok: true, title: '新标题' })
  assert.deepEqual(calls[0], { target: 'session-1', options: { source: 'sessionDashboardRow' } })
})

test('native rename reports a host refusal without throwing', async () => {
  const sessions = { using: async () => ({ ok: false, error: { code: 'session/rename', message: '宿主拒绝改名' } }) }
  assert.deepEqual(await renameNativeTitle(sessions, 'session-1', '新标题'), { ok: false, error: '宿主拒绝改名' })
})

test('native rename turns a thrown failure into a reported error', async () => {
  const sessions = { using: async () => { throw new Error('连接中断') } }
  assert.deepEqual(await renameNativeTitle(sessions, 'session-1', '新标题'), { ok: false, error: '连接中断' })
})
