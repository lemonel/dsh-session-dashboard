import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as plugin from '../lib/backend_index.js'
import { browserPeer, mountGatewayPrerequisites } from './tools/sdk.mjs'

for (const legacy of [false, true]) test(`formal backend entry mounts through Loader and reloads with ${legacy ? 'explicit legacy env' : 'host profile and no env'}`, async t => {
  const ctx = new Context(), fibers = []
  const profile = mkdtempSync(join(tmpdir(), 'session-dashboard-entry-'))
  const dataDir = join(profile, 'custom-data')
  const oldProfile = process.env.DSH_PROFILE_DIR
  if (legacy) process.env.DSH_PROFILE_DIR = profile
  else { delete process.env.DSH_PROFILE_DIR; ctx.reflect.provide('profileContext', { dir: profile, name: 'entry-test' }) }
  t.after(() => { if (oldProfile === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = oldProfile })
  ctx.reflect.provide('sessions', { get: () => undefined, list: () => [], async flush() { return true } })
  ctx.reflect.provide('agents', { get: () => undefined, list: () => [], roots: () => [] })
  ctx.reflect.provide('sessionQuery', { async listSessions() { return [] } })
  ctx.reflect.provide('sessionPersistence', { async list() { return [] }, async stat() { return undefined } })
  const { peer } = browserPeer(ctx, 'owner')
  const mount = async (value, config) => { const fiber = ctx.plugin(value, config); fibers.push(fiber); await fiber.await(); return fiber }
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  await mount(Registry)
  const access = await mountGatewayPrerequisites(ctx); if (access) fibers.push(access)
  await mount(Gateway, {})
  await mount(Loader, { baseUrl: new URL('../package.json', import.meta.url).href })
  const config = legacy ? { dataDir } : {}
  const entryId = await ctx.loader.create({ name: '@hsx/dsh-session-dashboard', config })
  await ctx.loader.await()
  const entry = ctx.loader.resolve(entryId)
  assert.ok(entry.fiber)
  await entry.fiber.await()
  assert.equal(entry.fiber.error, undefined)
  const call = (method, args = {}) => ctx.typertGateway.invoke({ namespace: 'sessionDashboard', method, args, peer })
  const before = await call('snapshot')
  assert.equal(before.board.cards.length, 0)
  assert.ok(existsSync(legacy ? join(dataDir, 'dashboard.sqlite') : join(profile, 'data/session-dashboard/dashboard.sqlite')))
  await entry.update({ disabled: true })
  await ctx.loader.await()
  assert.equal(ctx.get('sessionDashboard'), undefined)
  await assert.rejects(call('snapshot'))
  await entry.update({ disabled: false })
  await ctx.loader.await()
  assert.ok(entry.fiber)
  await entry.fiber.await()
  assert.equal(entry.fiber.error, undefined)
  assert.deepEqual((await call('snapshot')).board, before.board)
})

test('formal config default leaves optional dataDir absent and never requires developer path', () => {
  const config = plugin.Config({})
  assert.equal(config.dataDir, undefined)
  assert.deepEqual(plugin.inject, ['sessions', 'agents', 'sessionQuery', 'sessionPersistence', 'typert', 'connection'])
})
