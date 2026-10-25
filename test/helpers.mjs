import { randomUUID } from 'node:crypto'
import { SqliteBoardStore, digestCommand } from '../lib/backend/store.js'
import { DashboardService } from '../lib/backend/service.js'

export function fact(phase = 'completed', episode = 'turn:0', overrides = {}) {
  return { sync: 'synced', phase, episodeId: phase === 'not_started' ? null : episode, episodeOrder: phase === 'not_started' ? 0 : Number(episode.split(':').at(-1)) || 0, startedAt: phase === 'not_started' ? null : 100, endedAt: phase === 'completed' ? 200 : null, cursor: 10, sourceLive: true, fingerprint: `${episode}:${phase}`, explanation: null, attention: phase === 'waiting_input' ? 'answer' : phase === 'waiting_approval' ? 'approve' : phase === 'suspended' ? 'resume' : phase === 'failed' ? 'failure' : phase === 'interrupted' ? 'interrupted' : 'none', activeAgents: 0, ...overrides }
}
export function observation(phase = 'completed', episode = 'turn:0', overrides = {}) { return { runtime: fact(phase, episode, overrides), title: 'Existing session', workspace: '/one', activityAt: 200, hostArchive: { state: 'active', reason: null } } }
/** Explicit synthetic source seam for domain/transaction tests only. Never used by
 * the production AgentLoop/JSONL acceptance tier, and never enabled by default. */
export function replayFixture(sessionId, runtime = fact(), overrides = {}) {
  const sourceIdentity = digestCommand({ fixture: 'unit-replay-only', sessionId })
  return { sessionId, sourceIdentity, throughCursor: runtime.cursor,
    prefixDigests: Array.from({ length: runtime.cursor + 1 }, (_, index) => digestCommand({ sourceIdentity, index })),
    completions: runtime.phase === 'completed' && runtime.episodeId ? [{ episodeId: runtime.episodeId, cursor: runtime.cursor, endedAt: runtime.endedAt, digest: digestCommand({ sessionId, episode: runtime.episodeId }) }] : [],
    coverage: 'complete', reason: null, ...overrides }
}
export class FakeHost {
  values = new Map()
  sources = new Map()
  transcripts = new Map()
  listeners = new Set()
  generation = new Map()
  captureCount = 0
  probeValue = null
  closed = false
  async capture(id, includeReplay = true) {
    if (this.closed) throw new Error('Host closed')
    this.captureCount += 1
    const value = this.values.get(id)
    if (value instanceof Error) throw value
    if (!value) throw new Error('Host missing')
    const version = this.generation.get(id) || 0
    return { observation: structuredClone(value), ...(includeReplay && this.sources.has(id) ? { source: structuredClone(this.sources.get(id)) } : {}), validate: () => !this.closed && (this.generation.get(id) || 0) === version, dispose() {} }
  }
  async probe() { return this.probeValue ? structuredClone(this.probeValue) : { live: false, hostArchive: { state: 'active', reason: null } } }
  async list(query, membership = new Set()) {
    const rows = [...this.values].filter(([, value]) => !(value instanceof Error)).map(([sessionId, value]) => ({ sessionId, title: value.title, workspace: value.workspace, activityAt: value.activityAt, hostArchive: value.hostArchive })).filter(row => (query.membership !== 'tracked' || membership.has(row.sessionId)) && (query.membership !== 'untracked' || !membership.has(row.sessionId)) && (!query.hostArchive || query.hostArchive === 'all' || row.hostArchive.state === query.hostArchive)).filter(row => `${row.title} ${row.sessionId}`.toLowerCase().includes(query.search.toLowerCase()))
    return { items: rows.slice(query.offset, query.offset + query.limit), total: rows.length, nextOffset: query.offset + query.limit < rows.length ? query.offset + query.limit : null, generation: JSON.stringify([...this.generation]) }
  }
  async transcript(sessionId) { const value = this.transcripts.get(sessionId); if (value instanceof Error) throw value; return value ? structuredClone(value) : { messages: [], truncated: false } }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  set(id, value, notify = true) { this.values.set(id, value); this.generation.set(id, (this.generation.get(id) || 0) + 1); if (notify) for (const fn of this.listeners) fn(id) }
  setSource(id, source) { if (source === undefined) this.sources.delete(id); else this.sources.set(id, structuredClone(source)); this.generation.set(id, (this.generation.get(id) || 0) + 1) }
  close() { this.closed = true; this.listeners.clear(); this.sources.clear() }
}
/** Freeze exactly the card shown to the caller; raw mutate never fills missing CAS. */
export const workflowBinding = card => ({ sessionId: card.sessionId, membershipId: card.membershipId,
  expectedMetadataRevision: card.metadataRevision, expectedLifecycleRevision: card.lifecycleRevision,
  expectedWorkflowRevision: card.workflowRevision, episodeId: card.runtime.episodeId })
export const stateTarget = (status) => ({ statusId: status.id, expectedStatusRevision: status.revision })
export const mutationFor = (service, command, requestId = randomUUID()) => ({ apiVersion: 2, serviceId: service.serviceId, requestId, command })

export function harness(test, path = ':memory:') {
  const store = new SqliteBoardStore(path), host = new FakeHost(), errors = []
  let time = 1000
  const service = new DashboardService(store, host, error => errors.push(error), () => ++time)
  test.after(() => service.close())
  const mutate = (command, requestId = randomUUID()) => service.mutate(mutationFor(service, command, requestId))
  const inspect = sessionId => service.inspectSession({ sessionId })
  const join = async (sessionId, projectId = null) => {
    const { binding: inspection } = await inspect(sessionId)
    return mutate({ type: 'add_card', sessionId, projectId, inspection })
  }
  const add = async (id, phase = 'completed', projectId = null) => { host.set(id, observation(phase), false); return join(id, projectId) }
  const card = id => store.read().cards.find(row => row.sessionId === id)
  const sync = id => mutate({ type: 'resync', sessionId: id ?? null })
  const confirm = id => mutate({ type: 'confirm_review', ...workflowBinding(card(id)) })
  const review = async (id, action, extra = {}) => {
    // Completion now parks a round in 待确认; reviewing implies the human looked.
    const row = card(id)
    if (row.status === 'pending_confirm' && row.runtime.sync === 'synced' && row.runtime.sourceLive && row.runtime.phase === 'completed') await confirm(id)
    return mutate({ type: 'review', ...workflowBinding(card(id)), action, confirmed: true, destination: { kind: 'stay' }, ...extra })
  }
  const label = async (dimension, name) => { const value = await mutate(dimension === 'project' ? { type: 'create_project', name, color: null, tagIds: [] } : { type: 'create_label', dimension, name, color: null }); return (dimension === 'project' ? value.board.projects : dimension === 'status' ? value.board.statuses : value.board.tags).find(row => row.name === name) }
  const edit = (id, changes = {}, version = card(id).metadataRevision) => { const current = card(id); return mutate({ type: 'edit_card', sessionId: id, membershipId: current.membershipId, expectedMetadataRevision: version, tagIds: current.tagIds, titleOverride: current.titleOverride, progress: current.progress, ...changes }) }
  const archive = (id, archived, confirmedRunning = true) => mutate({ type: 'archive', sessionId: id, membershipId: card(id).membershipId, expectedMetadataRevision: card(id).metadataRevision, archived, confirmedRunning })
  const move = (id, projectId, destination, extra = {}) => mutate({ type: 'move_project', ...workflowBinding(card(id)), projectId, destination,
    expectedTargetProjectRevision: projectId === null ? null : store.read().projects.find(row => row.id === projectId)?.revision ?? 0, ...extra })
  return { store, host, service, mutate, inspect, join, add, card, sync, confirm, review, label, edit, archive, move, errors }
}
export const code = expected => error => error.code === expected
