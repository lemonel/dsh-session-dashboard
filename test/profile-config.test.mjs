import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { databasePath, profileBinding, profileDirectory } from '../lib/backend/config.js'
import { SqliteBoardStore } from '../lib/backend/store.js'

const invalid = error => error.code === 'INVALID'
const temporary = () => mkdtempSync(join(tmpdir(), 'dashboard-profile-config-'))
function context(profile) {
  const ctx = new Context()
  if (profile !== undefined) ctx.reflect.provide('profileContext', profile)
  return ctx
}

test('host profile resolves default data without env and overrides a conflicting env directory', () => {
  const dir = temporary(), other = temporary(), ctx = context({ dir, name: 'web' })
  const profile = profileDirectory(ctx, {})
  assert.equal(profile, resolve(dir))
  assert.equal(databasePath({}, profile), join(dir, 'data/session-dashboard/dashboard.sqlite'))
  assert.equal(profileDirectory(ctx, { DSH_PROFILE_DIR: other }), profile)
  assert.equal(profileDirectory(ctx, { DSH_PROFILE_DIR: 'relative' }), profile)
  assert.equal(profileBinding(profile), profileBinding(profileDirectory(ctx, { DSH_PROFILE_DIR: other })))
})

test('only absent host context permits explicit legacy env, never cwd or dataDir identity', () => {
  const dir = temporary(), ctx = context()
  assert.equal(profileDirectory(ctx, { DSH_PROFILE_DIR: dir }), resolve(dir))
  for (const value of [undefined, '', '  ', 'relative', '~/profiles/web']) {
    assert.throws(() => profileDirectory(ctx, { DSH_PROFILE_DIR: value }), invalid)
    assert.throws(() => databasePath({ dataDir: dir }, value), invalid)
    assert.throws(() => profileBinding(value), invalid)
  }
})

test('malformed present host profile cannot silently use valid env or custom dataDir', () => {
  const fallback = temporary()
  for (const profile of [null, false, 'not a profile', [], {}, { dir: null }, { dir: 42 }, { dir: '' }, { dir: '  ' }, { dir: 'relative' }]) {
    assert.throws(() => profileDirectory(context(profile), { DSH_PROFILE_DIR: fallback }), invalid)
  }
})

test('same directory preserves prior SHA-256 binding and existing database across host-context upgrade', t => {
  const dir = temporary(), dataDir = join(dir, 'custom'), path = join(dataDir, 'dashboard.sqlite')
  const boardPayload = () => { const db = new DatabaseSync(path); try { return db.prepare('SELECT payload FROM board WHERE id=1').get().payload } finally { db.close() } }
  const legacyBinding = createHash('sha256').update(realpathSync(resolve(dir))).digest('hex')
  const before = new SqliteBoardStore(path, legacyBinding)
  before.commit(null, board => { board.preferences.entry = 'review'; board.preferences.revision++; return true })
  const saved = before.read(), identity = before.identity(), payload = boardPayload()
  before.close()
  const hostProfile = profileDirectory(context({ dir, name: 'new display name' }), {})
  assert.equal(profileBinding(hostProfile), legacyBinding)
  assert.equal(profileBinding(profileDirectory(context(), { DSH_PROFILE_DIR: dir })), legacyBinding)
  const after = new SqliteBoardStore(databasePath({ dataDir }, hostProfile), profileBinding(hostProfile))
  t.after(() => after.close())
  // The durable row is untouched; the runtime projection only differs in the order
  // revisions that the single durable tag order derives.
  assert.equal(boardPayload(), payload, 'reopening a database in another host context rewrites nothing')
  assert.equal(after.read().revision, saved.revision)
  assert.deepEqual(after.read().cards, saved.cards)
  assert.deepEqual(after.read().preferences, saved.preferences)
  assert.deepEqual(after.read().orders.status, saved.orders.status)
  assert.deepEqual(after.read().orders.project.ids, saved.orders.project.ids)
  assert.deepEqual(after.read().orders.tag.ids, saved.orders.tag.ids)
  assert.deepEqual(after.identity(), identity)
})

test('custom storage never merges profiles with the same name or changes profile ownership', t => {
  const one = temporary(), two = temporary(), shared = temporary()
  const first = profileDirectory(context({ dir: one, name: 'web' }), {})
  const second = profileDirectory(context({ dir: two, name: 'web' }), {})
  assert.notEqual(profileBinding(first), profileBinding(second))
  assert.equal(profileBinding(first), profileBinding(profileDirectory(context({ dir: one, name: 'renamed' }), {})))
  assert.equal(databasePath({ dataDir: shared }, first), databasePath({ dataDir: shared }, second))
  const store = new SqliteBoardStore(databasePath({ dataDir: shared }, first), profileBinding(first))
  t.after(() => store.close())
  assert.throws(() => new SqliteBoardStore(databasePath({ dataDir: shared }, second), profileBinding(second)), error => error.code === 'FORBIDDEN')
  for (const dataDir of ['', '  ', 'relative', '~/custom']) assert.throws(() => databasePath({ dataDir }, first), invalid)
})

test('profile bindings retain canonical symlink and missing absolute directory behavior', () => {
  const dir = temporary(), alias = join(temporary(), 'profile-link')
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(profileBinding(alias), profileBinding(dir))
  assert.equal(profileBinding(profileDirectory(context({ dir: alias }), {})), profileBinding(dir))
  const missing = join(temporary(), 'not-created')
  assert.equal(profileBinding(missing), createHash('sha256').update(resolve(missing)).digest('hex'))
})
