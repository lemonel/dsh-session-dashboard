import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createDshHost } from '../lib/backend/dsh-host.js'
import { harness, observation, code } from './helpers.mjs'

const query = (extra = {}) => ({ search: '', offset: 0, limit: 20, ...extra })
const archived = value => ({ ...value, hostArchive: { state: 'archived', reason: null } })

test('N04 public candidate defaults filter membership and host archive before totals or pagination', async t => {
  const h = harness(t)
  for (let n = 0; n < 24; n++) await h.add(`tracked-${n}`)
  await h.archive('tracked-0', true)
  h.host.set('host-archive', archived(observation()), false)
  h.host.set('untracked-one', observation(), false)
  h.host.set('untracked-two', observation(), false)
  const page = await h.service.candidates(query({ limit: 1 }))
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1)
  assert.equal(page.items[0].sessionId, 'untracked-one'); assert.equal(page.items[0].tracked, null)
  const members = await h.service.candidates(query({ membership: 'tracked', hostArchive: 'all', limit: 100 }))
  assert.equal(members.total, 24); assert.ok(members.items.find(item => item.sessionId === 'tracked-0').tracked.archivedAt)
  const hostArchived = await h.service.candidates(query({ hostArchive: 'archived' }))
  assert.deepEqual(hostArchived.items.map(item => item.sessionId), ['host-archive'])
})

test('N04 generation identifies a corpus cut, not page size; candidate listing opens no session source', async t => {
  const h = harness(t)
  for (let n = 0; n < 5; n++) h.host.set(`session-${n}`, observation(), false)
  const captures = [], capture = h.host.capture.bind(h.host)
  h.host.capture = (id, includeReplay) => { captures.push(includeReplay); return capture(id) }
  const first = await h.service.candidates(query({ limit: 2 }))
  const next = await h.service.candidates(query({ offset: 2, limit: 1, generation: first.generation }))
  assert.equal(first.generation, next.generation); assert.equal(next.items[0].sessionId, 'session-2')
  const preflight = await h.service.candidates(query({ limit: 1, generation: first.generation }))
  assert.equal(preflight.generation, first.generation)
  assert.deepEqual(captures, [], 'listing candidates must not capture session sources')
})

test('N04 host archive change during a candidate read rejects the whole result rather than wrong total or hidden row', async t => {
  const h = harness(t); h.host.set('racing', observation(), false)
  const list = h.host.list.bind(h.host)
  let once = true
  h.host.list = async (...args) => {
    const page = await list(...args)
    if (once) { once = false; h.host.set('racing', archived(observation()), false) }
    return page
  }
  await assert.rejects(h.service.candidates(query()), code('CONFLICT'))
  const refreshed = await h.service.candidates(query())
  assert.equal(refreshed.total, 0); assert.equal(refreshed.items.length, 0)
})

test('N04 unrelated or excluded source change during candidate listing invalidates the source generation', async t => {
  const h = harness(t); h.host.set('candidate', observation(), false); h.host.set('excluded', archived(observation()), false)
  const list = h.host.list.bind(h.host)
  let once = true
  h.host.list = async (...args) => {
    const page = await list(...args)
    if (once) { once = false; h.host.set('excluded', observation('running'), false) }
    return page
  }
  await assert.rejects(h.service.candidates(query()), code('CONFLICT'))
})

test('N04 missing host generation, duplicate candidate identities and stale pagination fail closed', async t => {
  const h = harness(t); h.host.set('session', observation(), false)
  const list = h.host.list.bind(h.host)
  h.host.list = async (...args) => { const { generation, ...page } = await list(...args); return page }
  await assert.rejects(h.service.candidates(query()), code('UNAVAILABLE'))
  h.host.list = async (...args) => { const page = await list(...args); return { ...page, items: [...page.items, ...page.items] } }
  await assert.rejects(h.service.candidates(query()), code('UNAVAILABLE'))
  h.host.list = list
  const first = await h.service.candidates(query())
  h.host.set('new', observation(), false)
  await assert.rejects(h.service.candidates(query({ generation: first.generation })), code('CONFLICT'))
  await assert.rejects(h.service.candidates(query({ offset: 1 })), code('CONFLICT'))
})

test('N04 an adapter cannot publish active-filter results whose list archive fact disagrees', async t => {
  const h = harness(t); h.host.set('session', observation(), false)
  const list = h.host.list.bind(h.host)
  h.host.list = async (...args) => { const page = await list(...args); return { ...page, items: page.items.map(item => ({ ...item, hostArchive: { state: 'archived', reason: null } })) } }
  await assert.rejects(h.service.candidates(query()), code('CONFLICT'))
})

test('N04 board membership race during a candidate read invalidates the old query', async t => {
  const h = harness(t); h.host.set('candidate', observation(), false)
  const list = h.host.list.bind(h.host)
  let once = true
  h.host.list = async (...args) => {
    const page = await list(...args)
    if (once) {
      once = false
      h.store.commit(null, board => { board.cards.push({ sessionId: 'candidate', membershipId: '812b536c-41e2-4716-bf98-6119c36fed1c', hostArchive: { state: 'active', reason: null }, hostTitle: 'candidate', titleOverride: null, workspace: '/one', projectId: null, tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, origin: { kind: 'unspecified', episodeId: 'turn:0', episodeOrder: 0, reason: 'before_membership' }, placementWitness: null, workflowRevision: 0, runtime: observation().runtime, decision: null, joinedAt: 100, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }); return true })
    }
    return page
  }
  await assert.rejects(h.service.candidates(query()), code('CONFLICT'))
})

// Actual SDK adapter: listing never relies on a journal warmed only by a later capture.
class ListingPersistence extends SessionPersistence {
  constructor(ctx) { super(ctx) }
  async list() { return [] }
  async stat() { return undefined }
  async flush() {}
  async create() { throw new Error('Read-only listing probe') }
  async open() { throw new Error('Live listing must not consult raw persistence') }
}
test('N04 actual DshHost candidate generation survives cache warming and different page sizes', async t => {
  const root = new Context()
  const fiber = root.plugin(scope => { new SessionStore(scope); new AgentRegistry(scope); new SessionQueryEngine(scope); new ListingPersistence(scope) })
  await fiber.await()
  const ctx = fiber.ctx, host = createDshHost(ctx)
  t.after(async () => { host.close(); await fiber.dispose() })
  const session = ctx.sessions.create(SessionId('warm-cache'))
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const first = await host.list(query({ membership: 'all', hostArchive: 'all', limit: 20 }))
  assert.equal(first.total, 1); assert.equal(first.items[0].activityAt, null)
  const capture = await host.capture(session.id, false); capture.dispose()
  const next = await host.list(query({ membership: 'all', hostArchive: 'all', limit: 1, generation: first.generation }))
  assert.equal(next.generation, first.generation); assert.equal(next.items[0].activityAt, null)
})

// Runtime enrichment is a separate authoritative inspection, never a list side effect.
test('N04 candidate pages never capture untracked sessions and never fabricate runtime', async t => {
  const h = harness(t)
  h.host.set('untracked', observation('running'), false)
  await h.add('tracked')
  let captures = 0
  const capture = h.host.capture.bind(h.host)
  h.host.capture = (...args) => { captures += 1; return capture(...args) }
  const page = await h.service.candidates(query({ membership: 'all', hostArchive: 'all' }))
  assert.equal(captures, 0, 'the candidate list must not open any session source')
  const untracked = page.items.find(item => item.sessionId === 'untracked')
  const tracked = page.items.find(item => item.sessionId === 'tracked')
  assert.equal(untracked.tracked, null)
  assert.equal(untracked.runtime, null, 'an untracked row carries no runtime facts')
  assert.equal(untracked.hostArchive.state, 'active')
  assert.equal(tracked.runtime.sync, 'synced')
  assert.deepEqual(tracked.runtime, h.card('tracked').runtime, 'a tracked row keeps its stored runtime')
})

// Title scan cost: a 200-session corpus where every readTitle fold is counted.
const CORPUS_SIZE = 200
class CorpusPersistence extends SessionPersistence {
  constructor(ctx) { super(ctx) }
  async list() { return [] }
  async stat() { return undefined }
  async flush() {}
  async create() { throw new Error('Read-only candidate probe') }
  async open() { throw new Error('A title fold must not open an unexpected raw source here') }
}
async function syntheticCorpus(t, size = CORPUS_SIZE) {
  const root = new Context()
  let engine = null
  const fiber = root.plugin(scope => { new SessionStore(scope); new AgentRegistry(scope); engine = new SessionQueryEngine(scope); new CorpusPersistence(scope) })
  await fiber.await()
  const ctx = fiber.ctx
  for (let n = 0; n < size; n++) {
    const id = `corpus-${String(n).padStart(3, '0')}`
    const session = ctx.sessions.create(SessionId(id))
    // corpus-000 intentionally has no logged title: it must fall back to its identity.
    if (n !== 0) session.append('session/title', { title: `Synthetic session ${n}`, messageSeqs: [], source: { kind: 'user' } })
  }
  const counts = { reads: 0, inFlight: 0, peak: 0 }
  const readTitle = engine.readTitle.bind(engine)
  engine.readTitle = async (id, signal) => {
    counts.reads += 1; counts.inFlight += 1; counts.peak = Math.max(counts.peak, counts.inFlight)
    try { return await readTitle(id, signal) } finally { counts.inFlight -= 1 }
  }
  const host = createDshHost(ctx)
  t.after(async () => { host.close(); await fiber.dispose() })
  const reset = () => { counts.reads = 0; counts.peak = 0 }
  return { ctx, host, counts, reset }
}
const corpusQuery = extra => ({ search: '', offset: 0, limit: 20, membership: 'all', hostArchive: 'all', ...extra })
const titleOf = id => id === 'corpus-000' ? id : `Synthetic session ${Number(id.slice(-3))}`

test('N04 an unsearched candidate page folds titles only for the page window it returns', async t => {
  const { host, counts, reset } = await syntheticCorpus(t)
  const page = await host.list(corpusQuery())
  assert.equal(page.total, CORPUS_SIZE); assert.equal(page.items.length, 20); assert.equal(page.nextOffset, 20)
  assert.equal(counts.reads, 20, `page one folded ${counts.reads} titles for a 20-row window`)
  assert.deepEqual(page.items.map(item => [item.sessionId, item.title]), page.items.map(item => [item.sessionId, titleOf(item.sessionId)]))
  assert.equal(page.items.every(item => item.title.length > 0), true, 'a title is never an empty row')
  // The generation identifies the corpus cut, not the page window that was folded.
  reset()
  const second = await host.list(corpusQuery({ offset: 20, limit: 10, generation: page.generation }))
  assert.equal(second.generation, page.generation); assert.equal(second.items.length, 10)
  assert.equal(counts.reads, 10, `page two folded ${counts.reads} titles for a 10-row window`)
  reset()
  const repeated = await host.list(corpusQuery({ offset: 20, limit: 10, generation: page.generation }))
  assert.equal(repeated.generation, page.generation); assert.equal(counts.reads, 0, `a repeated page re-folded ${counts.reads} titles instead of reusing the cache`)
})

test('N04 a title search folds the filtered corpus concurrently and reuses cached titles', async t => {
  const { ctx, host, counts, reset } = await syntheticCorpus(t)
  const page = await host.list(corpusQuery({ search: 'synthetic session 19', limit: 20 }))
  assert.equal(page.total, 11, '19 plus 190-199 match the folded titles')
  assert.equal(counts.reads, CORPUS_SIZE, `a title search must fold every filtered title once, folded ${counts.reads}`)
  assert.ok(counts.peak >= 8, `title folds ran with only ${counts.peak} concurrent reads`)
  reset()
  const again = await host.list(corpusQuery({ search: 'synthetic session 19', limit: 5, generation: page.generation }))
  assert.equal(again.generation, page.generation); assert.equal(again.items.length, 5)
  assert.equal(counts.reads, 0, `a repeated identical query re-folded ${counts.reads} titles instead of reusing the cache`)
  // A narrowed page of the same search is still a cache hit.
  reset()
  const nextPage = await host.list(corpusQuery({ search: 'synthetic session 19', offset: 5, limit: 5, generation: page.generation }))
  assert.equal(nextPage.generation, page.generation); assert.equal(counts.reads, 0)
  // A live title change must move the searched generation and be folded again, or a
  // later page could reuse an offset against a different match set.
  reset()
  ctx.sessions.get(SessionId('corpus-019')).append('session/title', { title: 'Renamed live title', messageSeqs: [], source: { kind: 'user' } })
  await assert.rejects(host.list(corpusQuery({ search: 'synthetic session 19', limit: 5, generation: page.generation })), error => error.code === 'CONFLICT')
  const fresh = await host.list(corpusQuery({ search: 'synthetic session 19', limit: 20 }))
  assert.equal(fresh.total, 10, 'the renamed live title is folded again, not served from the cache')
  assert.equal(fresh.generation === page.generation, false)
})
