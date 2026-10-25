import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'
import { MembershipDialog, MembershipRuntime, createMembershipRequests } from '../lib/frontend/Membership.js'
import { StaticLocaleProvider, translateLocale } from '../lib/frontend/i18n.js'
import { dictionaries } from '../lib/frontend/locales.js'
import { projectDictionaries } from '../lib/frontend/project-locales.js'
import { reviewBinding, effectiveTags } from '../lib/frontend/view-model.js'
import { errorMessage, RpcFailure, unwrapRemote, DashboardClient } from '../lib/frontend/client.js'
import { harness, observation } from './helpers.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { cleanup, fireEvent, render, screen, waitFor, within, act } = await import('@testing-library/react')
afterEach(() => { cleanup(); document.body.replaceChildren() })
const ok = value => ({ ok: true, value: structuredClone(value) })
const label = (id, name = id) => ({ id, name, color: null, createdAt: 1, revision: 0 })
const status = (id, name = id) => label(id, name)
function card(id = 'work', extra = {}) { return { sessionId: id, membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'Work', titleOverride: null, workspace: '/work', projectId: 'p1', tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: 'pending_review' }, origin: { kind: 'state', episodeId: 'run:1', episodeOrder: 1, state: { statusId: 's1', statusName: 'Original state', statusRevision: 0 } }, placementWitness: null, workflowRevision: 1, runtime: { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'completed', episodeId: 'run:1', episodeOrder: 1, endedAt: 200, attention: 'none', fingerprint: 'run:1' }, decision: null, joinedAt: 1, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 1, lifecycleRevision: 1, ...extra } }
function board(current = card()) { const value = emptyBoard(); value.projects = [{ ...label('p1', 'Current project'), tagIds: ['public'] }, { ...label('p2', 'Other project'), tagIds: [] }]; value.statuses = [status('s1', 'Research'), status('s2', 'Development'), status('s3', 'On hold')]; value.orders.status.ids = ['in_progress', 'pending_confirm', 'pending_review', 'accepted', 's1', 's2', 's3']; value.orders.project.ids = ['p1', 'p2', '__none__']; value.cards = [current]; return value }
function handshake(serviceId) { const yes = { available: true, reason: null }; return { apiVersion: 2, serviceId, scope: { scopeId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222', recoveryId: '33333333-3333-4333-8333-333333333333' }, capabilities: Object.fromEntries(['query', 'events', 'completionReplay', 'evidenceCheck', 'nativeSidebarFilter', 'isolatedExecution', 'externalDelivery', 'projectWorkflow', 'businessHistory', 'sessionInspection', 'sidebarEntry'].map(key => [key, yes])) } }
function memberApi(value, serviceId = randomUUID(), extra = {}) {
  const snapshot = { board: value, health: { state: 'ready', message: null, lastSyncAt: 1 } }, current = value.cards[0]
  const candidate = { sessionId: current?.sessionId ?? 'new', title: 'Session', workspace: '/work', activityAt: 1, tracked: current ?? null, runtime: current?.runtime ?? { ...unknownRuntime(), sync: 'synced', sourceLive: true, phase: 'not_started', attention: 'none' }, hostArchive: { state: 'active', reason: null } }
  const inspection = { snapshot, candidate, binding: { serviceId, boardRevision: value.revision, membershipId: current?.membershipId ?? null, metadataRevision: current?.metadataRevision ?? null, lifecycleRevision: current?.lifecycleRevision ?? null, workflowRevision: current?.workflowRevision ?? null, runtimeFingerprint: candidate.runtime.fingerprint, sourceIdentity: null, sourceCursor: null, hostArchiveGeneration: 'generation-1' } }
  const mutations = [], queries = []
  const api = { handshake: async () => ok(handshake(serviceId)), snapshot: async () => ok(snapshot), candidates: async query => { queries.push(query); return ok({ items: [candidate], total: 1, nextOffset: null, generation: 'generation-1' }) }, inspectSession: async () => ok(inspection), mutate: async input => { mutations.push(input); return ok(snapshot) }, ...extra }
  return { api, snapshot, inspection, serviceId, mutations, queries }
}
const tracked = (current, serviceId) => ({ kind: 'tracked', sessionId: current.sessionId, membershipId: current.membershipId, metadataRevision: current.metadataRevision, binding: reviewBinding(current), serviceId })

test('singleton member runtime preserves an open intent; another drop cannot silently replace target or success state', () => {
  const runtime = new MembershipRuntime(), source = { kind: 'sidebar', sessionId: 'same', displayTitle: 'Same' }
  runtime.open(source, 'p1'); const first = runtime.getSnapshot(); runtime.open(source, 'p2'); assert.equal(runtime.getSnapshot(), first); assert.equal(runtime.getSnapshot().projectId, 'p1')
  runtime.close(); runtime.open(source, 'p2'); assert.equal(runtime.getSnapshot().projectId, 'p2'); runtime.dispose(); runtime.open(source, 'p1'); assert.equal(runtime.getSnapshot(), null)
})

test('tracked remove/readd and mismatched exact inspection never rebind the stale drag', async () => {
  const original = card(), replaced = { ...original, membershipId: randomUUID() }, f = memberApi(board(replaced))
  render(React.createElement(MembershipDialog, { api: f.api, request: { source: tracked(original, f.serviceId), projectId: 'p2' }, onClose() {}, onChanged() {} }))
  await screen.findByRole('alert'); assert.equal(screen.getByRole('button', { name: '确认加入 / 移动' }).disabled, true); assert.equal(f.mutations.length, 0)
  cleanup()
  const b = emptyBoard(), g = memberApi(b); g.inspection.candidate.sessionId = 'wrong'
  render(React.createElement(MembershipDialog, { api: g.api, request: { source: { kind: 'sidebar', sessionId: 'wanted', displayTitle: 'Wanted' }, projectId: null }, onClose() {}, onChanged() {} }))
  await screen.findByRole('alert'); assert.equal(g.mutations.length, 0); assert.equal(screen.getByRole('button', { name: '确认加入 / 移动' }).disabled, true)
})


test('cross-project move without unresolved builtin process requires explicit target including unset', async () => {
  const current = card('move', { placement: { kind: 'custom', statusId: 's1' }, status: 'accepted' }), f = memberApi(board(current))
  render(React.createElement(MembershipDialog, { api: f.api, request: { source: tracked(current, f.serviceId), projectId: 'p2' }, onClose() {}, onChanged() {} }))
  const select = await screen.findByLabelText('请选择状态（无默认）'), submit = screen.getByRole('button', { name: '确认加入 / 移动' })
  assert.equal(select.value, ''); assert.equal(submit.disabled, true)
  fireEvent.change(select, { target: { value: '__unset__' } }); fireEvent.click(submit)
  await waitFor(() => assert.equal(f.mutations.length, 1)); assert.deepEqual(f.mutations[0].command.destination, { kind: 'unset' }); assert.equal(f.mutations[0].apiVersion, 2); assert.equal(f.mutations[0].serviceId, f.serviceId)
})

test('sidebar membership uses actual service inspect/mutate, no mounted DashboardClient, and never historical acceptance', async t => {
  const h = harness(t); h.host.set('new', observation('not_started'), false)
  const project = await h.label('project', 'Before sessions')
  const wrapped = work => async input => { try { return ok(await work(input)) } catch (error) { return { ok: false, error: { code: 'dashboard/error', message: error.message, details: { reason: error.code } } } } }
  const api = { handshake: async () => ok(handshake(h.service.serviceId)), snapshot: wrapped(() => h.service.snapshot()), candidates: wrapped(query => h.service.candidates(query)), inspectSession: wrapped(query => h.service.inspectSession(query)), mutate: wrapped(input => h.service.mutate(input)) }
  render(React.createElement(MembershipDialog, { api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: project.id }, onClose() {}, onChanged() {} }))
  const submit = await screen.findByRole('button', { name: '确认加入 / 移动' }); await waitFor(() => assert.equal(submit.disabled, false)); fireEvent.click(submit)
  await screen.findByText(/项目成员关系已保存/)
  const current = h.card('new'); assert.equal(current.projectId, project.id); assert.equal(current.status, 'in_progress'); assert.deepEqual(current.placement, { kind: 'unset' }); assert.equal(current.decision, null); assert.equal(h.store.read().cards.length, 1)
})

test('unmount while inspection is pending ignores stale response and produces no mutation', async () => {
  const f = memberApi(emptyBoard()); let release; const pending = new Promise(resolve => { release = resolve }); f.api.inspectSession = () => pending
  const view = render(React.createElement(MembershipDialog, { api: f.api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: null }, onClose() {}, onChanged() {} }))
  await waitFor(() => assert.ok(screen.getByText('正在可靠核对所选会话…'))); view.unmount(); await act(async () => release(ok(f.inspection))); assert.equal(f.mutations.length, 0)
})

test('pending preferences finish before membership inspection and cannot self-conflict the inspected absence cut', async t => {
  const h = harness(t); h.host.set('new', observation('not_started'), false)
  const calls = []
  const wrap = (method, work) => async input => { calls.push(method); try { return ok(await work(input)) } catch (error) { return { ok: false, error: { code: 'dashboard/error', message: error.message, details: { reason: error.code } } } } }
  const api = { handshake: async () => ok(handshake(h.service.serviceId)), snapshot: wrap('snapshot', () => h.service.snapshot()), candidates: wrap('candidates', query => h.service.candidates(query)), inspectSession: wrap('inspect', query => h.service.inspectSession(query)), mutate: async input => { calls.push(input.command.type); return ok(await h.service.mutate(input)) } }
  const client = new DashboardClient(api, 60000); client.start(); t.after(() => client.stop()); await client.refresh()
  const runtime = new MembershipRuntime(), requests = createMembershipRequests(client, runtime); t.after(() => { requests.dispose(); runtime.dispose() })
  client.updatePreferences(value => ({ ...value, entry: 'unassigned' }))
  const intent = { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }
  await requests.requestJoin(intent, null)
  assert.equal(runtime.getSnapshot().source, intent, 'preference flush never substitutes or rebinds the source')
  render(React.createElement(MembershipDialog, { api, request: runtime.getSnapshot(), onClose() {}, onChanged() {} }))
  const submit = screen.getByRole('button', { name: '确认加入 / 移动' }); await waitFor(() => assert.equal(submit.disabled, false)); fireEvent.click(submit)
  await screen.findByText(/项目成员关系已保存/)
  assert.ok(calls.indexOf('preferences') < calls.indexOf('inspect'))
  assert.equal(calls.filter(value => value === 'add_card').length, 1, 'no automatic mutation retry')
  assert.equal(h.card('new').projectId, null); assert.equal(h.store.read().preferences.entry, 'unassigned')
})

test('membership opening retains immutable intent on flush failure and ignores completion after disposal', async () => {
  const runtime = new MembershipRuntime(), source = { kind: 'sidebar', sessionId: 'wanted', displayTitle: 'Wanted' }, notices = []
  const rejected = createMembershipRequests({ flushPreferences: async () => false, noticeKey: value => notices.push(value) }, runtime)
  const skipped = await rejected.requestJoin(source, 'p1'); assert.equal(skipped.status, 'skipped'); assert.equal(runtime.getSnapshot(), null); assert.deepEqual(notices, ['preferencesUnsaved'])
  let resolve; const pending = new Promise(done => { resolve = done })
  const disposed = createMembershipRequests({ flushPreferences: () => pending, noticeKey: value => notices.push(value) }, runtime)
  const opening = disposed.requestJoin(source, 'p1'); disposed.dispose(); resolve(true); await opening
  assert.equal(runtime.getSnapshot(), null); rejected.dispose(); runtime.dispose()
})

test('member completion reports the visible outcome and an explicit locate action without altering preferences', async () => {
  const value = emptyBoard(); value.projects = [{ ...label('p1'), tagIds: [] }]; value.statuses = [status('s1')]
  const f = memberApi(value), saved = card('new', { projectId: 'p1', placement: { kind: 'unset' } }); f.snapshot.board.cards.push(saved)
  const before = structuredClone(value.preferences), t = translateLocale('zh'); let located = 0
  render(React.createElement(MembershipDialog, { api: f.api, request: { source: { kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, projectId: 'p1' }, onClose() {}, onChanged() { return { message: t('joinedVisible'), locate: () => { located++ } } } }))
  const confirm = screen.getByRole('button', { name: '确认加入 / 移动' }); await waitFor(() => assert.equal(confirm.disabled, false)); fireEvent.click(confirm)
  await screen.findByText('会话已保存并符合当前视图；筛选条件保持不变。'); assert.equal(located, 0); assert.deepEqual(value.preferences, before)
  fireEvent.click(screen.getByRole('button', { name: '查看此会话详情' })); assert.equal(located, 1); assert.deepEqual(value.preferences, before)
})

function joinClient() {
  const notices = []
  return { notices, client: { flushPreferences: async () => true, noticeKey: key => notices.push(key) } }
}

const targetBoard = () => { const value = emptyBoard(); value.projects = [{ ...label('p1', 'Current project'), tagIds: [] }, { ...label('p2', 'Other project'), tagIds: [] }]; value.statuses = [status('s1'), status('other', 'Research')]; value.orders.status.ids = ['in_progress', 'pending_confirm', 'pending_review', 'accepted', 's1', 'other']; value.orders.project.ids = ['p1', 'p2']; return value }

test('a determined target applies immediately for add, preserve move and same-project no-op', async () => {
  const addedValue = targetBoard(), added = memberApi(addedValue), addClient = joinClient(), addRuntime = new MembershipRuntime(), applied = []
  const addRequests = createMembershipRequests(addClient.client, addRuntime, { api: added.api, applied: (snapshot, id, serviceId) => { applied.push([id, serviceId]); return { message: 'saved', locate() {}, noticeKey: 'joinedVisible' } } })
  const appliedResult = await addRequests.requestJoin({ kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, 'p1')
  assert.equal(appliedResult.status, 'applied')
  assert.equal(added.mutations.length, 1); assert.equal(added.mutations[0].command.type, 'add_card'); assert.equal(added.mutations[0].command.projectId, 'p1')
  assert.equal(addRuntime.getSnapshot(), null, 'no dialog is opened for a determined target')
  assert.deepEqual(addClient.notices, ['joinedVisible']); assert.deepEqual(applied, [['new', added.serviceId]]); addRequests.dispose()

  const current = card('move', { placement: { kind: 'builtin', status: 'pending_review' } })
  const moved = memberApi(board(current)), moveClient = joinClient(), moveRuntime = new MembershipRuntime()
  const moveRequests = createMembershipRequests(moveClient.client, moveRuntime, { api: moved.api })
  const movedResult = await moveRequests.requestJoin(tracked(current, moved.serviceId), 'p2')
  assert.equal(movedResult.status, 'applied')
  assert.equal(moved.mutations.length, 1); assert.deepEqual(moved.mutations[0].command.destination, { kind: 'preserve' })
  assert.equal(moveRuntime.getSnapshot(), null); assert.deepEqual(moveClient.notices, ['membershipSuccess']); moveRequests.dispose()

  const same = memberApi(board(current)), sameClient = joinClient(), sameRuntime = new MembershipRuntime()
  const sameRequests = createMembershipRequests(sameClient.client, sameRuntime, { api: same.api })
  const sameResult = await sameRequests.requestJoin(tracked(current, same.serviceId), 'p1')
  assert.equal(sameResult.status, 'same')
  assert.equal(same.mutations.length, 0); assert.deepEqual(sameClient.notices, ['alreadySameProject']); assert.equal(sameRuntime.getSnapshot(), null); sameRequests.dispose()
})

test('an unset cross-project destination keeps the dialog and reuses the completed inspection', async () => {
  const current = card('move', { placement: { kind: 'custom', statusId: 's1' }, status: 'accepted' })
  const f = memberApi(board(current)); let inspections = 0; const inspected = f.api.inspectSession
  f.api.inspectSession = async query => { inspections++; return inspected(query) }
  const { client, notices } = joinClient(), runtime = new MembershipRuntime()
  const requests = createMembershipRequests(client, runtime, { api: f.api })
  const dialogResult = await requests.requestJoin(tracked(current, f.serviceId), 'p2')
  assert.equal(dialogResult.status, 'dialog')
  assert.equal(f.mutations.length, 0); assert.equal(inspections, 1); assert.deepEqual(notices, [])
  const request = runtime.getSnapshot(); assert.ok(request?.inspected)
  render(React.createElement(MembershipDialog, { api: f.api, request, onClose() {}, onChanged() {} }))
  const select = await screen.findByLabelText('请选择状态（无默认）')
  assert.equal(select.value, ''); assert.equal(inspections, 1, 'the dialog does not repeat the inspected query')
  assert.equal(screen.getByRole('button', { name: '确认加入 / 移动' }).disabled, true)
  requests.dispose(); runtime.dispose()
})

test('host archive uncertainty and failed inspection keep the dialog without writing', async () => {
  const value = targetBoard(), archived = memberApi(value)
  archived.inspection.candidate.hostArchive = { state: 'archived', reason: null }
  const archiveRuntime = new MembershipRuntime(), archiveClient = joinClient()
  const archiveRequests = createMembershipRequests(archiveClient.client, archiveRuntime, { api: archived.api })
  await archiveRequests.requestJoin({ kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, 'p1')
  assert.equal(archived.mutations.length, 0); assert.deepEqual(archiveClient.notices, []); assert.ok(archiveRuntime.getSnapshot()?.inspected)
  render(React.createElement(MembershipDialog, { api: archived.api, request: archiveRuntime.getSnapshot(), onClose() {}, onChanged() {} }))
  assert.equal(await screen.findByRole('button', { name: '确认加入 / 移动' }).then(button => button.disabled), true, 'explicit host-archive confirmation is still required')
  cleanup()

  const failed = memberApi(value); failed.api.inspectSession = async () => { throw new Error('inspection unavailable') }
  const failedRuntime = new MembershipRuntime(), failedClient = joinClient()
  const failedRequests = createMembershipRequests(failedClient.client, failedRuntime, { api: failed.api })
  await failedRequests.requestJoin({ kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, 'p1')
  assert.equal(failed.mutations.length, 0); assert.deepEqual(failedClient.notices, [])
  assert.ok(failedRuntime.getSnapshot() && failedRuntime.getSnapshot().inspected === undefined, 'the dialog rechecks a failed inspection')
  render(React.createElement(MembershipDialog, { api: failed.api, request: failedRuntime.getSnapshot(), onClose() {}, onChanged() {} }))
  await screen.findByRole('alert')
  assert.equal(failed.mutations.length, 0)
  archiveRequests.dispose(); archiveRuntime.dispose(); failedRequests.dispose(); failedRuntime.dispose()
})

test('translation keys and placeholders match, English errors use structured reason and custom names stay untouched', () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of Object.keys(dictionaries.zh)) assert.deepEqual(placeholders(dictionaries.zh[key]), placeholders(dictionaries.en[key]), key)
  assert.deepEqual(Object.keys(projectDictionaries.zh).sort(), Object.keys(projectDictionaries.en).sort())
  for (const key of Object.keys(projectDictionaries.zh)) assert.deepEqual(placeholders(projectDictionaries.zh[key]), placeholders(projectDictionaries.en[key]), `project.${key}`)
  const t = translateLocale('en'); let failure; try { unwrapRemote({ ok: false, error: { code: 'dashboard/error', message: '不能直接覆盖新数据', details: { reason: 'CONFLICT' } } }) } catch (error) { failure = error }
  assert.equal(failure.code, 'CONFLICT'); assert.match(errorMessage(failure, t), /Another operation/); assert.doesNotMatch(errorMessage(failure, t), /不能/)
  assert.equal(translateLocale('unknown')('title'), 'Session Dashboard')
  const current = card('tags', { tagIds: ['public', 'own'] }), value = board(current); assert.deepEqual(effectiveTags(value, current), ['public', 'own'])
})

test('a rejected membership mutation reports failure while preserving the inspected intent', async () => {
  const value = targetBoard(), denied = memberApi(value, randomUUID(), { mutate: async () => ({ ok: false, error: { code: 'dashboard/error', message: 'write denied', details: { reason: 'STORAGE' } } }) })
  const runtime = new MembershipRuntime(), client = joinClient()
  const requests = createMembershipRequests(client.client, runtime, { api: denied.api })
  const result = await requests.requestJoin({ kind: 'sidebar', sessionId: 'new', displayTitle: 'New' }, 'p1')
  assert.equal(result.status, 'failed')
  assert.equal(runtime.getSnapshot(), null, 'an applied target never opens the dialog after a transport failure')
  requests.dispose(); runtime.dispose()
})
