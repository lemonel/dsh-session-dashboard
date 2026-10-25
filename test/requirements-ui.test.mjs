import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import React from 'react'
import { emptyBoard, EMPTY, unknownRuntime } from '../lib/shared/model.js'
import { DashboardClient } from '../lib/frontend/client.js'
import { Dashboard } from '../lib/frontend/Dashboard.js'
import { needsAction, attentionKind, entryCards, reviewBucket } from '../lib/frontend/view-model.js'
import { PROJECT_DRAG_TYPE, parseProjectDrag } from '../lib/frontend/project-drag.js'
import { MembershipDialog, MembershipRuntime, createMembershipRequests } from '../lib/frontend/Membership.js'
import { mutationSchema } from '../lib/shared/commands.js'
import { reviewBinding } from '../lib/frontend/view-model.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle })) Object.defineProperty(globalThis, key, { configurable: true, value })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const clients = new Set()
afterEach(() => { cleanup(); for (const client of clients) client.stop(); clients.clear(); document.body.replaceChildren() })
const archive = state => ({ state, reason: null })
const label = (id, name = id) => ({ id, name, color: null, createdAt: 1, revision: 0 })
function fact(extra = {}) { return { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'round-1', episodeOrder: 1, endedAt: 200, cursor: 2, sourceLive: true, attention: 'none', fingerprint: 'round-1-completed', ...extra } }
function card(id, extra = {}) { return { sessionId: id, membershipId: randomUUID(), hostArchive: archive('active'), hostTitle: id, titleOverride: null, workspace: '/workspace', projectId: null, tagIds: [], progress: '', status: 'pending_review', placement: { kind: 'builtin', status: extra.status ?? 'pending_review' }, origin: null, placementWitness: null, workflowRevision: 1, runtime: fact(), decision: null, joinedAt: 100, activityAt: 200, updatedAt: 200, reviewAt: 200, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 1, ...extra } }
function candidate(id, extra = {}) { return { sessionId: id, title: id, workspace: '/workspace', activityAt: 200, tracked: null, runtime: fact(), hostArchive: archive('active'), ...extra } }
const ok = value => ({ ok: true, value: structuredClone(value) })
const fail = (message, code = 'CONFLICT') => ({ ok: false, error: { code, message } })
function fixture(cards = []) {
  const board = emptyBoard(); board.cards = cards; board.preferences.entry = 'board'
  board.projects = [label('p1', '项目一'), label('p2', '项目二')].map(value => ({ ...value, tagIds: [] })); board.orders.project.ids = ['p1', 'p2', EMPTY]
  const stored = { board, health: { state: 'ready', message: null, lastSyncAt: 200 } }
  const commands = [], queries = [], navigationQueries = [], navigations = [], inspections = []
  const yes = { available: true, reason: null }, no = { available: false, reason: 'unavailable' }
  const handshake = { apiVersion: 2, serviceId: randomUUID(), scope: { scopeId: randomUUID(), storeId: randomUUID(), recoveryId: randomUUID() }, capabilities: { query: yes, events: yes, completionReplay: yes, evidenceCheck: yes, nativeSidebarFilter: no, isolatedExecution: no, externalDelivery: no, projectWorkflow: yes, businessHistory: yes, sessionInspection: yes, sidebarEntry: no } }
  const inspectionBinding = current => ({ serviceId: handshake.serviceId, boardRevision: board.revision, membershipId: current?.membershipId ?? null, metadataRevision: current?.metadataRevision ?? null, lifecycleRevision: current?.lifecycleRevision ?? null, workflowRevision: current?.workflowRevision ?? null, runtimeFingerprint: current?.runtime.fingerprint ?? 'round-1-completed', sourceIdentity: null, sourceCursor: null, hostArchiveGeneration: 'test-host-archive-1' })
  let source = [], generation = 'generation-1', candidateFailure = null, denyNavigation = null
  const api = {
    handshake: async () => ok(handshake),
    history: async query => ok({ sessionId: query.sessionId, membershipId: query.membershipId, records: [], nextAfter: null, retainedFrom: 1, highWatermark: 0, truncated: false, gap: false }),
    inspectSession: async query => { inspections.push(query); const current = board.cards.find(card => card.sessionId === query.sessionId) ?? null, item = source.find(row => row.sessionId === query.sessionId) ?? candidate(query.sessionId); return ok({ snapshot: stored, candidate: { ...item, tracked: current, runtime: current?.runtime ?? item.runtime }, binding: inspectionBinding(current) }) },
    snapshot: async () => ok(stored),
    candidates: async query => {
      queries.push(structuredClone(query))
      if (candidateFailure) return fail(candidateFailure, 'UNAVAILABLE')
      if (query.generation && query.generation !== generation) return fail('成员或宿主归档状态发生变化')
      const values = source.map(item => ({ ...item, tracked: board.cards.find(card => card.sessionId === item.sessionId) ?? null })).filter(item => (query.membership === 'all' || query.membership === 'tracked' ? query.membership === 'all' || item.tracked !== null : item.tracked === null) && (query.hostArchive === 'all' || item.hostArchive.state === (query.hostArchive ?? 'active')) && item.title.includes(query.search))
      const items = values.slice(query.offset, query.offset + query.limit)
      return ok({ items, total: values.length, nextOffset: query.offset + items.length < values.length ? query.offset + items.length : null, generation })
    },
    navigation: async query => {
      navigationQueries.push(query)
      const target = board.cards.find(card => card.sessionId === query.sessionId)
      if (denyNavigation) return ok({ sessionId: query.sessionId, allowed: false, reason: denyNavigation, hostArchive: target?.hostArchive ?? archive('unknown') })
      if (query.expectedLifecycleRevision !== undefined && (query.expectedLifecycleRevision !== target?.lifecycleRevision || query.runtimeFingerprint !== target?.runtime.fingerprint)) return fail('等待请求已变化，请重新核对', 'REVIEW_STALE')
      const hostArchive = target?.hostArchive ?? source.find(candidate => candidate.sessionId === query.sessionId)?.hostArchive ?? archive('unknown')
      return ok({ sessionId: query.sessionId, allowed: hostArchive.state === 'active', reason: hostArchive.state === 'archived' ? 'DSH 会话已归档，需要在宿主取消归档' : null, hostArchive })
    },
    mutate: async raw => {
      const input = mutationSchema.parse(raw); assert.equal(input.serviceId, handshake.serviceId)
      const command = input.command; commands.push(command)
      if (command.type === 'preferences') board.preferences = { ...command.value, revision: board.preferences.revision + 1 }
      if (command.type === 'move_project') {
        const target = board.cards.find(card => card.sessionId === command.sessionId)
        if (!target || target.membershipId !== command.membershipId || target.metadataRevision !== command.expectedMetadataRevision || target.lifecycleRevision !== command.expectedLifecycleRevision || target.workflowRevision !== command.expectedWorkflowRevision || target.archivedAt !== null) return fail('元数据冲突或已归档')
        target.projectId = command.projectId; target.metadataRevision++; target.workflowRevision++
      }
      if (command.type === 'add_card' && !board.cards.some(card => card.sessionId === command.sessionId)) {
        assert.deepEqual(command.inspection, inspectionBinding(null), 'join must carry the explicit inspected absence cut')
        board.cards.push(card(command.sessionId, { projectId: command.projectId })); generation += '-member'
      }
      if (command.type === 'edit_card') {
        const target = board.cards.find(card => card.sessionId === command.sessionId)
        if (!target || target.metadataRevision !== command.expectedMetadataRevision) return fail('字段冲突')
        for (const key of ['tagIds', 'titleOverride', 'progress']) target[key] = structuredClone(command[key])
        target.metadataRevision++
      }
      board.revision++; return ok(stored)
    },
  }
  const client = new DashboardClient(api, 60000); clients.add(client)
  function FixtureView() {
    const runtime = React.useMemo(() => new MembershipRuntime(), [])
    const requests = React.useMemo(() => createMembershipRequests(client, runtime, { api, applied: () => { void client.refresh() } }), [])
    React.useEffect(() => () => { requests.dispose(); runtime.dispose() }, [requests, runtime])
    const request = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
    return React.createElement(React.Fragment, null,
      React.createElement(Dashboard, { client, openSession: id => navigations.push(id), requestJoin: requests.requestJoin }),
      request && React.createElement(MembershipDialog, { api, request, onClose: runtime.close, onChanged: () => { void client.refresh() } }))
  }
  return { client, api, stored, commands, queries, navigationQueries, navigations, inspections, handshake, set source(value) { source = value }, set generation(value) { generation = value }, set candidateFailure(value) { candidateFailure = value }, set denyNavigation(value) { denyNavigation = value }, render: () => render(React.createElement(FixtureView)) }
}
function transfer(initial = {}) { const data = new Map(Object.entries(initial)); return { types: [...data.keys()], setData(type, value) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type) }, getData: type => data.get(type) ?? '', effectAllowed: '', dropEffect: '' } }
/** The drawer opens from the row menu only: the row title owns the preview. */
const open = async id => {
  await openBoard()
  fireEvent.click(await screen.findByRole('button', { name: `会话行操作：${id}` }))
  fireEvent.click(within(await screen.findByRole('group', { name: `会话行操作：${id}` })).getByRole('button', { name: '会话详情' }))
  return screen.findByRole('dialog', { name: '会话详情' })
}
/** 项目总览 is the only view; 项目一 starts expanded, so its rows are listed. */
async function openBoard() {
  const tile = await screen.findByRole('article', { name: '项目一' })
  const toggle = tile.querySelector('.sd-projecttoggle')
  if (toggle?.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  await within(tile).findByRole('region', { name: /^项目一 · / })
}
/** The tests that exercise board surfaces file their cards into 项目一 first. */
function inProject(f, id = 'p1') { for (const value of f.stored.board.cards) value.projectId = id; return f }
const refresh = async f => { await act(async () => { await f.client.refresh() }) }

// N01: structured facts alone determine attention; continuation gaps and labels do not.
test('N01 structured attention facts mark only the actionable row and never auto-answer', async () => {
  const answer = card('Answer', { status: 'in_progress', runtime: fact({ phase: 'waiting_input', attention: 'answer', explanation: '请回答当前问题' }) })
  const continuation = card('Continuation', { status: 'in_progress', tagIds: ['waiting_input'], runtime: fact({ phase: 'continuation_pending', attention: 'none' }) })
  const f = inProject(fixture([answer, continuation, card('Pending'), card('Board archived', { archivedAt: 300, runtime: fact({ attention: 'approve' }) })]))
  f.render(); await openBoard()
  assert.equal(needsAction(continuation), false)
  // Only the structured attention row carries the mark; the review row stays quiet.
  const mark = id => document.querySelector(`[data-card-id="${id}"] .sd-attentioninline`)
  assert.equal(mark('Answer')?.textContent, '待输入', 'the actionable row names what the human has to do')
  assert.equal(mark('Continuation'), null, 'a waiting_input tag never manufactures attention')
  assert.equal(mark('Pending'), null, 'a review card is not an attention card')
  assert.equal(document.querySelector('.sd-projectrow[data-card-id="Board archived"]'), null, 'an archived card is not in the project list')
  assert.equal(f.commands.some(command => ['review', 'prompt', 'answer', 'approve'].includes(command.type)), false)
})

test('N02 tracked project drag moves membership in one step with preserve and no confirmation dialog', async () => {
  const original = card('Move', { projectId: 'p1', tagIds: ['tag'], progress: 'keep', titleOverride: 'Move', runtime: fact() })
  const binding = reviewBinding(original)
  const f = fixture([original]); f.render()
  // The project row's own grip now carries the tracked payload onto another project card.
  const grip = await screen.findByRole('button', { name: '拖动到项目卡片以移动：Move' })
  const dt = transfer(); fireEvent.dragStart(grip, { dataTransfer: dt })
  assert.ok(dt.types.includes(PROJECT_DRAG_TYPE)); assert.equal(dt.types.includes('application/x-session-dashboard'), false)
  const target = await screen.findByRole('article', { name: '项目二' })
  fireEvent.drop(target, { dataTransfer: dt })
  await waitFor(() => assert.equal(f.stored.board.cards[0].projectId, 'p2'))
  assert.equal(screen.queryByRole('dialog', { name: '加入或移动到项目' }), null, 'a determined project needs no confirmation dialog')
  assert.deepEqual(f.commands.find(command => command.type === 'move_project'), { type: 'move_project', ...binding, projectId: 'p2', expectedTargetProjectRevision: 0, destination: { kind: 'preserve' } })
  assert.equal(f.stored.board.cards[0].status, 'pending_review'); assert.deepEqual(f.stored.board.cards[0].tagIds, ['tag']); assert.equal(f.stored.board.cards[0].progress, 'keep')
  assert.equal(f.commands.some(command => command.type === 'edit_card'), false)
})
test('N02 stale membership or newly board-archived dragged card cannot move or restore', async () => {
  const f = fixture([card('Stale move', { projectId: 'p1' })]); f.render()
  const grip = await screen.findByRole('button', { name: '拖动到项目卡片以移动：Stale move' })
  const dt = transfer(); fireEvent.dragStart(grip, { dataTransfer: dt })
  f.stored.board.cards[0].membershipId = randomUUID(); f.stored.board.revision++; await refresh(f)
  fireEvent.drop(await screen.findByRole('article', { name: '项目二' }), { dataTransfer: dt })
  await screen.findByText(/当前成员、轮次或来源已变化/)
  fireEvent.click(within(screen.getByRole('dialog', { name: '加入或移动到项目' })).getByRole('button', { name: '取消' }))
  const fresh = transfer(); fireEvent.dragStart(await screen.findByRole('button', { name: '拖动到项目卡片以移动：Stale move' }), { dataTransfer: fresh })
  f.stored.board.cards[0].archivedAt = 400; f.stored.board.revision++; await refresh(f)
  fireEvent.drop(screen.getByRole('article', { name: '项目二' }), { dataTransfer: fresh })
  const confirm = await screen.findByRole('dialog', { name: '加入或移动到项目' })
  await within(confirm).findByText(/看板归档/)
  assert.equal(within(confirm).getByRole('button', { name: '确认加入 / 移动' }).disabled, true)
  assert.equal(f.commands.some(command => command.type === 'archive' || command.type === 'move_project'), false)
})
test('N05 the row and drawer both show the host archive state and never turn it into a local archive', async () => {
  const f = inProject(fixture([card('Host archived', { hostArchive: archive('archived'), runtime: fact({ attention: 'answer' }) })]))
  f.render(); await openBoard()
  const tile = document.querySelector('[data-card-id="Host archived"]')
  assert.ok(within(tile).getByText('DSH 会话已归档'), 'the row carries the host archive badge')
  assert.equal(f.commands.some(command => ['archive', 'review', 'edit_card'].includes(command.type)), false)
  // The drawer keeps showing the host archive state and does not touch the local draft on a poll.
  const drawer = await open('Host archived')
  assert.ok(within(drawer).getByText('DSH 会话已归档'))
  fireEvent.change(within(drawer).getByLabelText('一句话进展'), { target: { value: '保留本地草稿' } })
  await refresh(f)
  assert.equal(screen.getByLabelText('一句话进展').value, '保留本地草稿')
  assert.equal(f.stored.board.cards[0].archivedAt, null, 'absence of local archive is never a host unarchive')
})
// A finished round belongs to review even when the observation is cold; only an
// unverifiable *running* round still needs a sync action.
test('N04 a completed round keeps its review bucket when the observation is cold', () => {
  const cold = card('Cold', { status: 'pending_confirm', placement: { kind: 'builtin', status: 'pending_confirm' }, runtime: fact({ sourceLive: false }) })
  const warm = card('Warm', { status: 'pending_confirm', placement: { kind: 'builtin', status: 'pending_confirm' } })
  assert.equal(attentionKind(cold), 'none', 'a finished round is not an action item just because the observation is cold')
  assert.equal(needsAction(cold), false)
  assert.equal(reviewBucket(cold), 1)
  assert.equal(reviewBucket(warm), 1)
  const board = emptyBoard(); board.cards = [cold, warm]
  assert.deepEqual(entryCards(board, 'review').map(item => item.sessionId).sort(), ['Cold', 'Warm'])
  assert.deepEqual(entryCards(board, 'attention'), [])
  const runningCold = card('Live', { status: 'in_progress', runtime: fact({ phase: 'running', episodeId: 'round-2', sourceLive: false }) })
  assert.equal(needsAction(runningCold), true, 'a running round without a live check still needs a sync action')
  assert.equal(attentionKind(runningCold), 'sync')
})
