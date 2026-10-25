import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LifecycleJournal } from '../lib/backend/lifecycle.js'
import { emptyBoard, runtimeSchema, turnEndSchema } from '../lib/shared/model.js'
import { parseBoard } from '../lib/backend/invariants.js'

const header = (id = 'session') => ({ id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
const idle = { sourceLive: true, status: 'idle', goal: null, goalAvailable: false, questions: [], inputWaits: 0, approvalWaits: 0 }
function setup() {
  const session = Session.create(SessionId('session'))
  const journal = new LifecycleJournal(session.header, 0)
  const append = (type, data, ...rest) => { const event = session.append(type, data, ...rest); journal.append(event); return event }
  const begin = (turn = 1) => { append('turn/start', { turn }); return append('step/start', { turn, step: 1 }) }
  const prompt = (source = { kind: 'user' }) => append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'a prompt' }] }), { surfaceOp: 'append' })
  const end = (reason, turn = 1) => append('turn/end', { turn, reason })
  const fact = (environment = idle) => runtimeSchema.parse(journal.fact(environment))
  return { session, journal, append, begin, prompt, end, fact }
}

test('a completed turn exposes the system completed reason', () => {
  const h = setup(); h.begin(); h.prompt(); h.end({ kind: 'completed' })
  const fact = h.fact()
  assert.equal(fact.phase, 'completed')
  assert.deepEqual(fact.turnEnd, { kind: 'completed' })
})

test('an error turn exposes the structured LLM failure identity without its message', () => {
  const h = setup(); h.begin(); h.prompt(); h.end({ kind: 'error', error: { code: 'rate_limit', message: 'Provider said something very long and private', status: 429 } })
  const fact = h.fact()
  assert.equal(fact.phase, 'failed')
  assert.deepEqual(fact.turnEnd, { kind: 'error', error: { code: 'rate_limit', status: 429 } })
  assert.equal(JSON.stringify(fact.turnEnd).includes('private'), false, 'the failure message never enters the dashboard fact')
  const minimal = setup(); minimal.begin(); minimal.prompt(); minimal.end({ kind: 'error' })
  assert.equal('turnEnd' in minimal.fact(), false, 'a failure without its structured identity is not exposed')
})

test('an aborted turn keeps the host cancellation cause, including a manual stop', () => {
  const h = setup(); h.begin(); h.prompt(); h.end({ kind: 'aborted', reason: { kind: 'user' } })
  assert.equal(h.fact().phase, 'interrupted')
  assert.deepEqual(h.fact().turnEnd, { kind: 'aborted', cause: 'user' })
  const other = setup(); other.begin(); other.prompt(); other.end({ kind: 'aborted', reason: { kind: 'disposed' } })
  assert.deepEqual(other.fact().turnEnd, { kind: 'aborted', cause: 'disposed' })
  const bare = setup(); bare.begin(); bare.prompt(); bare.end({ kind: 'aborted' })
  assert.equal('turnEnd' in bare.fact(), false, 'an aborted turn without a known cause stays untranslated')
  const futureCause = setup(); futureCause.begin(); futureCause.prompt(); futureCause.end({ kind: 'aborted', reason: { kind: 'socket' } })
  assert.equal('turnEnd' in futureCause.fact(), false, 'an extended cancellation cause waits for the union, it is never renamed')
})

test('interrupted, max-tokens and an unknown future kind pass through verbatim', () => {
  const interrupted = setup(); interrupted.begin(); interrupted.prompt(); interrupted.end({ kind: 'interrupted' })
  assert.equal(interrupted.fact().phase, 'interrupted')
  assert.deepEqual(interrupted.fact().turnEnd, { kind: 'interrupted' })
  const capped = setup(); capped.begin(); capped.prompt(); capped.end({ kind: 'max-tokens' })
  assert.equal(capped.fact().phase, 'suspended')
  assert.deepEqual(capped.fact().turnEnd, { kind: 'max-tokens' }, 'the phase stays suspended but the system reason is still exposed')
  const future = setup(); future.begin(); future.prompt(); future.end({ kind: 'future-reason' })
  assert.equal(future.fact().phase, 'suspended', 'an extended host reason keeps the previous phase behaviour')
  assert.equal('turnEnd' in future.fact(), false, 'an extended host kind is not exposed until the union gains it')
})

test('an unclosed run has no turn end reason; the dashboard never invents interrupted', () => {
  const h = setup(); h.begin(); h.prompt()
  const fact = h.fact({ ...idle, status: 'running' })
  assert.equal(fact.phase, 'running')
  assert.equal('turnEnd' in fact, false)
  const orphan = setup(); orphan.begin(); orphan.prompt()
  const suspended = orphan.fact({ ...idle, sourceLive: false, status: null })
  assert.equal(suspended.phase, 'suspended')
  assert.equal('turnEnd' in suspended, false, 'without a closer the system has not said why the run ended')
})

test('the pending-input override withdraws a closer that no longer decides the fact', () => {
  const h = setup(); h.begin(); h.prompt(); h.end({ kind: 'completed' })
  const overridden = h.fact({ ...idle, pendingInput: 1 })
  assert.equal(overridden.phase, 'continuation_pending')
  assert.equal('turnEnd' in overridden, false)
})

function card(runtime) {
  return { sessionId: 'a', membershipId: randomUUID(), hostArchive: { state: 'active', reason: null }, hostTitle: 'A', titleOverride: null, workspace: null, projectId: null,
    tagIds: [], progress: '', status: 'in_progress', placement: { kind: 'builtin', status: 'in_progress' }, origin: null, placementWitness: null, workflowRevision: 0,
    runtime, decision: null, joinedAt: 1, activityAt: null, updatedAt: 1, reviewAt: null, acceptedAt: null, archivedAt: null, metadataRevision: 0, lifecycleRevision: 0 }
}
const baseRuntime = () => ({ sync: 'synced', phase: 'not_started', episodeId: null, episodeOrder: 0, startedAt: null, endedAt: null, cursor: 0, sourceLive: true, fingerprint: 'initial', explanation: null, attention: 'none', activeAgents: 0 })

test('every known variant parses and every unknown or incomplete shape is rejected', () => {
  for (const kind of ['completed', 'blocked', 'max-tokens', 'interrupted', 'forked']) assert.deepEqual(turnEndSchema.parse({ kind }), { kind })
  for (const cause of ['user', 'parent', 'hook', 'disposed', 'legacy']) assert.deepEqual(turnEndSchema.parse({ kind: 'aborted', cause }), { kind: 'aborted', cause })
  assert.deepEqual(turnEndSchema.parse({ kind: 'error', error: { code: 'rate_limit' } }), { kind: 'error', error: { code: 'rate_limit' } })
  assert.deepEqual(turnEndSchema.parse({ kind: 'error', error: { code: 'rate_limit', status: 429 } }), { kind: 'error', error: { code: 'rate_limit', status: 429 } })
  assert.throws(() => turnEndSchema.parse({ kind: 'completed', extra: true }), 'variants are strict')
  assert.throws(() => turnEndSchema.parse({ kind: 'aborted' }), 'aborted always names its cause')
  assert.throws(() => turnEndSchema.parse({ kind: 'aborted', cause: 'socket' }), 'an unknown cause is not a variant yet')
  assert.throws(() => turnEndSchema.parse({ kind: 'error' }), 'error always carries its failure identity')
  assert.throws(() => turnEndSchema.parse({ kind: 'error', error: { code: 'x', status: 42 } }))
  assert.throws(() => turnEndSchema.parse({ kind: 'error', error: { code: 'x', message: 'not persisted' } }))
  assert.throws(() => turnEndSchema.parse({ kind: 'future-reason' }), 'an unknown kind is not silently accepted')
})

test('the turn-end field is additive across persisted boards', () => {
  const oldBoard = emptyBoard(); oldBoard.cards = [card(baseRuntime())]
  assert.equal(parseBoard(oldBoard).cards[0].runtime.turnEnd, undefined, 'a board without the field keeps parsing')
  const nextBoard = emptyBoard(); nextBoard.cards = [card({ ...baseRuntime(), turnEnd: { kind: 'error', error: { code: 'rate_limit', status: 429 } } })]
  assert.deepEqual(parseBoard(nextBoard).cards[0].runtime.turnEnd, { kind: 'error', error: { code: 'rate_limit', status: 429 } })
})
