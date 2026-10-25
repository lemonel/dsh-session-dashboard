import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { randomUUID } from 'node:crypto'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { DashboardClient, parseSnapshot, unwrapRemote } from '../lib/frontend/client.js'
import { cardDraft, dirtyDraft, dirtyFields, draftSchema, editCommand, openEditor } from '../lib/frontend/editor.js'
import { activityOrder, reviewBinding, reviewProblem, runtimeGuidance, statusActivityOrder } from '../lib/frontend/view-model.js'
import { createSessionInWorkspace, failureReason } from '../lib/frontend/session-create.js'
import { promptNewSession } from '../lib/frontend/session-prompt.js'

const active = new Set()
afterEach(() => { for (const client of active) client.stop(); active.clear() })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fact(extra = {}) { return { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', episodeOrder: 1, endedAt: 200, cursor: 2, sourceLive: true, ...extra } }
function card(id, extra = {}) { return { sessionId: id, membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: id, titleOverride: null, workspace: '/workspace', projectId: null, tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: extra.status ?? 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 1, runtime: fact(), decision: null, joinedAt: 100, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 1, ...extra } }
function snapshot(cards = []) { const board = emptyBoard(); board.cards = cards; return { board, health: { state: 'ready', message: null, lastSyncAt: 200 } } }
const ok = value => ({ ok: true, value: structuredClone(value) })
function start(api, ms = 60000) { const client = new DashboardClient(api, ms); active.add(client); client.start(); return client }
function handshake() { const yes = { available: true, reason: null }, no = { available: false, reason: 'unavailable' }; return { apiVersion: 2, serviceId: '22222222-2222-4222-8222-222222222222', scope: { scopeId: '33333333-3333-4333-8333-333333333333', storeId: '44444444-4444-4444-8444-444444444444', recoveryId: '55555555-5555-4555-8555-555555555555' }, capabilities: { query: yes, events: yes, completionReplay: yes, evidenceCheck: yes, nativeSidebarFilter: no, isolatedExecution: no, externalDelivery: no, projectWorkflow: yes, businessHistory: yes, sessionInspection: yes, sidebarEntry: no } } }
function noApi() { return { handshake: async () => ok(handshake()), snapshot: async () => ok(snapshot()), candidates: async () => ok({ items: [], total: 0, nextOffset: null, generation: 'fixture' }), mutate: async () => ok(snapshot()) } }

test('RPC schemas reject malformed success and nested runtime', () => {
  assert.deepEqual(parseSnapshot(ok(snapshot())).board.cards, [])
  assert.throws(() => parseSnapshot({ ok: true, value: { board: {} } }), /未通过校验/)
  assert.throws(() => parseSnapshot({ board: emptyBoard() }), /返回格式/)
  assert.throws(() => unwrapRemote({ ok: false, error: { code: 'dashboard/error', message: '轮次已变化', details: { reason: 'REVIEW_STALE' } } }), /轮次已变化/)
  assert.throws(() => parseSnapshot(ok(snapshot([card('bad', { runtime: { phase: 'completed' } })]))), /未通过校验/)
})

test('review binding is episode AND lifecycle bound; cold/unknown/degraded state cannot accept', () => {
  const sample = card('s')
  const binding = reviewBinding(sample)
  assert.equal(reviewProblem(sample, 'accept', binding, true), null)
  assert.match(reviewProblem({ ...sample, runtime: fact({ sourceLive: false }) }, 'accept', binding, true), /先进入会话/)
  assert.match(reviewProblem({ ...sample, runtime: fact({ sync: 'unknown' }) }, 'accept', binding, true), /同步/)
  assert.match(reviewProblem(sample, 'accept', binding, false), /同步/)
  assert.match(reviewProblem({ ...sample, lifecycleRevision: 2, runtime: fact({ episodeId: 'round-2' }) }, 'accept', binding, true), /轮次/)
  assert.match(reviewProblem({ ...sample, archivedAt: 300 }, 'accept', binding, true), /恢复归档/)
})

test('new session creation targets the chosen workspace and surfaces refusals', async () => {
  const calls = []
  const sessions = { async create(options) { calls.push(options); return 'created' } }
  assert.equal(await createSessionInWorkspace(sessions, 'ws-1'), 'created')
  assert.deepEqual(calls[0], { workspaceId: 'ws-1' }, 'creation always targets the explicit workspace id')
  const failing = { async create() { throw new Error('workspace/unavailable') } }
  await assert.rejects(createSessionInWorkspace(failing, 'ws-1'), /workspace\/unavailable/, 'a refused creation propagates its reason')
  assert.equal(failureReason(new Error('workspace/unavailable')), 'workspace/unavailable')
  assert.equal(failureReason('plain denial'), 'plain denial')
  assert.ok(failureReason(new Error('x'.repeat(300))).length <= 200, 'a long reason is bounded for the toast')
})

test('a starting message queues one text turn through the retained session reference', async () => {
  const calls = []
  const sessions = { async using(sessionId, options, run) {
    calls.push(['use', sessionId, options.source])
    return run({ binding: { session: { async prompt(content, mode) { calls.push(['prompt', content, mode]); return { ok: true, value: { accepted: true } } } } } })
  } }
  assert.deepEqual(await promptNewSession(sessions, 'session-1', 'hello'), { ok: true })
  assert.deepEqual(calls, [['use', 'session-1', 'sessionDashboardCreate'], ['prompt', [{ type: 'text', text: 'hello' }], 'queue']])
  const refused = { async using(sessionId, options, run) { return run({ binding: { session: { async prompt() { return { ok: false, error: { message: 'prompt/denied' } } } } } }) } }
  assert.deepEqual(await promptNewSession(refused, 'session-1', 'hello'), { ok: false, error: 'prompt/denied' })
  const throwing = { async using() { throw new Error('controller closed') } }
  assert.deepEqual(await promptNewSession(throwing, 'session-1', 'hello'), { ok: false, error: 'controller closed' })
})

test('activity order is newest first, and the roster follows configured status order then activity', () => {
  const a = card('a', { activityAt: 300 }), b = card('b', { activityAt: 200 })
  assert.deepEqual(activityOrder([b, a]).map(card => card.sessionId), ['a', 'b'], 'newest activity first')
  assert.deepEqual(activityOrder([a, { ...b, activityAt: 999 }]).map(card => card.sessionId), ['b', 'a'], 'a new activity reorders immediately')
  const board = emptyBoard()
  board.statuses = [{ id: 's1', name: 'S1', color: null, createdAt: 1, revision: 0 }]
  board.orders.status.ids.push('s1')
  const inProgress = card('in-progress', { status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, activityAt: 10, reviewAt: null })
  const oldReview = card('old-review', { activityAt: 200 })
  const newReview = card('new-review', { activityAt: 300 })
  const accepted = card('accepted', { status: 'accepted', placement: { kind: 'builtin', status: 'accepted' }, activityAt: 50, reviewAt: null })
  const custom = card('custom', { status: 'in_progress', placement: { kind: 'custom', statusId: 's1' }, activityAt: 400, reviewAt: null })
  const unset = card('unset', { status: 'in_progress', placement: { kind: 'unset' }, activityAt: 500, reviewAt: null })
  assert.deepEqual(statusActivityOrder(board, [unset, custom, accepted, newReview, oldReview, inProgress]).map(card => card.sessionId),
    ['in-progress', 'new-review', 'old-review', 'accepted', 'custom', 'unset'], 'configured status order first, newest activity inside one status, unset last')
})

test('draft commands retain base metadata CAS independently of current runtime lifecycle', () => {
  const draft = cardDraft(card('s', { metadataRevision: 5 }))
  assert.equal(dirtyDraft(draft), false)
  const edited = { ...draft, progress: '尚未保存', titleOverride: ' 本地标题 ' }
  assert.equal(dirtyDraft(edited), true)
  assert.equal(editCommand(edited).expectedMetadataRevision, 5)
  assert.equal(editCommand(edited).titleOverride, '本地标题')
})

test('D03 runtime guidance uses current live explanations and phase-specific next steps without tag inference', () => {
  for (const explanation of ['目标已阻塞，等待人工处理或恢复', '目标已暂停，等待恢复', '活动目标在当前进程未获续跑授权，需人工恢复']) {
    const sample = card('s', { status: 'in_progress', runtime: fact({ phase: 'suspended', explanation }) })
    assert.deepEqual(runtimeGuidance(sample), { explanation, nextStep: '进入会话查看原因，按需处理阻塞或恢复目标；此处不会自动恢复。' })
    assert.equal(runtimeGuidance({ ...sample, runtime: { ...sample.runtime, sync: 'unknown' } }), null)
    assert.equal(runtimeGuidance({ ...sample, runtime: { ...sample.runtime, sourceLive: false } }), null)
  }
  assert.match(runtimeGuidance(card('cancelled', { runtime: fact({ phase: 'interrupted', explanation: '活动目标已取消' }) })).nextStep, /中断或取消/)
  assert.match(runtimeGuidance(card('input', { runtime: fact({ phase: 'waiting_input' }) })).nextStep, /不提供原地答复/)
  assert.match(runtimeGuidance(card('approval', { runtime: fact({ phase: 'waiting_approval' }) })).nextStep, /不能直接批准/)
  assert.equal(runtimeGuidance(card('tag-is-not-runtime', { tagIds: ['blocked', 'paused'] })), null)
})

test('D04 pending tag name is dirty panel input, not a saved card field or implicit creation', () => {
  const draft = cardDraft(card('s', { metadataRevision: 7 }))
  assert.equal(draft.tagName, '')
  for (const tagName of ['待创建名称', '   ']) {
    const pending = draftSchema.parse({ ...draft, tagName })
    assert.equal(dirtyDraft(pending), true)
    assert.equal(dirtyFields(pending), false)
    assert.deepEqual(editCommand(pending), editCommand(draft), 'pending name must not enter edit_card RPC')
    const changed = { ...pending, progress: '独立卡片字段' }
    assert.equal(dirtyFields(changed), true)
    const saved = { ...cardDraft(card('s', { progress: changed.progress, metadataRevision: 8 })), tagName }
    assert.equal(dirtyDraft(saved), true, 'saving card metadata must not claim the entire draft is saved')
    assert.equal(dirtyFields(saved), false)
    assert.equal(dirtyDraft({ ...saved, tagName: '' }), false)
  }
})

test('overlapping reads coalesce and old reads cannot overwrite a settled write', async () => {
  const old = deferred()
  const latest = snapshot([card('new')]); latest.board.revision = 2
  let reads = 0
  const client = start({ ...noApi(), snapshot: async () => ++reads === 1 ? ok(snapshot()) : old.promise, mutate: async () => ok(latest) })
  await client.refresh() // Establish the mandatory API2 service epoch before writing.
  const concurrent = client.refresh(); const coalesced = client.refresh()
  await tick()
  assert.equal(reads, 2)
  const result = await client.mutate({ type: 'resync', sessionId: null })
  assert.equal(result.board.cards[0].sessionId, 'new')
  old.resolve(ok(snapshot([card('stale')])))
  await concurrent; await coalesced; await tick()
  assert.equal(reads, 3) // A write-invalidated read is followed by one fresh request.
  assert.equal(client.getSnapshot().snapshot.board.cards[0].sessionId, 'new')
})

test('writes serialize; preference writes are coalesced, latest-revision CAS and not retried in a storm', async () => {
  let stored = snapshot()
  const calls = []
  let inFlight = 0, maximum = 0
  const client = start({ ...noApi(), snapshot: async () => ok(stored), mutate: async input => {
    calls.push(input); maximum = Math.max(maximum, ++inFlight); await tick()
    const command = input.command
    if (command.type === 'preferences') {
      assert.equal(command.expectedRevision, stored.board.preferences.revision)
      stored.board.preferences = { ...command.value, revision: command.expectedRevision + 1 }
    }
    stored.board.revision++; inFlight--; return ok(stored)
  } })
  await tick()
  client.updatePreferences(current => ({ ...current, entry: 'archive' }))
  client.updatePreferences(current => ({ ...current, locations: { ...current.locations, projects: { x: 12, y: 34 } } }))
  await Promise.all([client.mutate({ type: 'resync', sessionId: null }), client.flushPreferences(), client.mutate({ type: 'resync', sessionId: 's' })])
  assert.equal(maximum, 1)
  const prefs = calls.filter(call => call.command.type === 'preferences')
  assert.equal(prefs.length, 1)
  assert.equal(prefs[0].command.value.entry, 'archive')
  assert.deepEqual(prefs[0].command.value.locations.projects, { x: 12, y: 34 })
  assert.equal(new Set(calls.map(call => call.requestId)).size, calls.length)
  calls.forEach(call => assert.match(call.requestId, /^[0-9a-f-]{36}$/))
})

test('preference conflict retains the local view preference and pauses automatic retry until explicit retry', async () => {
  const stored = snapshot()
  let calls = 0
  const client = start({ ...noApi(), snapshot: async () => ok(stored), mutate: async () => { calls++; return { ok: false, error: { code: 'dashboard/error', message: '其他窗口已修改' } } } })
  await tick()
  client.updatePreferences(current => ({ ...current, locations: { ...current.locations, projects: { x: 55, y: 66 } } }))
  assert.equal(await client.flushPreferences(), false)
  assert.deepEqual(client.getSnapshot().preferences.locations.projects, { x: 55, y: 66 })
  assert.match(client.getSnapshot().preferenceError, /失败|修改/)
  await tick(); await tick()
  assert.equal(calls, 1)
})

test('stop suppresses late results, retains unsaved draft; restart fetches a fresh lifetime', async () => {
  const pending = deferred(); let reads = 0
  const client = start({ ...noApi(), snapshot: async () => ++reads === 1 ? pending.promise : ok(snapshot([card('fresh')])) })
  client.viewDraft = openEditor(card('s')); client.viewDraft.draft.progress = '未保存'; client.viewDraft.draft.tagName = '未创建'
  client.stop(); client.start()
  pending.resolve(ok(snapshot([card('stale')]))); await tick(); await tick()
  assert.equal(client.getSnapshot().snapshot.board.cards[0].sessionId, 'fresh')
  assert.equal(client.viewDraft.draft.progress, '未保存')
  assert.equal(client.viewDraft.draft.tagName, '未创建')
  assert.equal(reads, 2)
})

test('late write from stopped lifetime never leaves remounted client busy', async () => {
  const pending = deferred()
  const client = start({ ...noApi(), mutate: async () => pending.promise })
  await tick()
  const write = client.mutate({ type: 'resync', sessionId: null })
  await tick(); assert.equal(client.getSnapshot().pending, 1)
  client.stop(); client.start()
  assert.equal(client.getSnapshot().pending, 0)
  pending.resolve(ok(snapshot())); await write; await tick()
  assert.equal(client.getSnapshot().pending, 0)
})

test('polling runs only while document visible, no overlap, and cleans listener/timer on stop', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true })
  const previous = globalThis.document
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  let visible = 'hidden', calls = 0
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visible })
  const client = start({ ...noApi(), snapshot: async () => { calls++; return ok(snapshot()) } }, 10)
  await tick(); assert.equal(calls, 1)
  visible = 'visible'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  await tick(); assert.equal(calls, 2)
  visible = 'hidden'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  client.stop()
  visible = 'visible'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  await tick(); assert.equal(calls, 2)
  Object.defineProperty(globalThis, 'document', { configurable: true, value: previous })
  dom.window.close()
})
