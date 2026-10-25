import test from 'node:test'
import assert from 'node:assert/strict'
import { LifecycleJournal } from '../lib/backend/lifecycle.js'
import { SqliteBoardStore } from '../lib/backend/store.js'

const header = { id: 'session-checkpoint', createdAt: 1, cwd: '/workspace' }

function journalWithEvents() {
  const journal = new LifecycleJournal(header, 0)
  journal.append({ seq: 0, time: 10, type: 'unknown/plugin-event', data: { value: 'a' } })
  journal.append({ seq: 1, time: 20, type: 'unknown/plugin-event', data: { value: 'b' } })
  return journal
}

test('the lifecycle journal checkpoint restores the exact cursor and can continue', () => {
  const journal = journalWithEvents()
  journal.title = 'Restored title'
  const state = journal.serialize()
  const restored = LifecycleJournal.restore(header, 0, state)
  assert.equal(restored.cursor, 2)
  assert.equal(restored.title, 'Restored title')
  assert.deepEqual(restored.serialize(), state)
  restored.append({ seq: 2, time: 30, type: 'unknown/plugin-event', data: { value: 'c' } })
  assert.equal(restored.cursor, 3)
})

test('a journal checkpoint refuses a different session or inherited boundary', () => {
  const state = journalWithEvents().serialize()
  assert.throws(() => LifecycleJournal.restore({ ...header, id: 'other' }, 0, state), /does not match/)
  assert.throws(() => LifecycleJournal.restore(header, 1, state), /does not match/)
})

test('source fold checkpoints are bound to the session and survive a store reopen', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-fold-'))
  const path = join(directory, 'dashboard.sqlite')
  try {
    const state = journalWithEvents().serialize()
    const checkpoint = {
      sessionId: header.id, persistenceIdentity: 'persistence-a', headerDigest: 'header-a', inherited: 0, revision: 'rev-1',
      cursor: 2, sourceIdentity: 'identity-a', legacySourceIdentity: 'legacy-a', fromCursor: 0, fromDigest: 'c'.repeat(64), prefixDigest: 'a'.repeat(64),
      history: [{ cursor: 0, digest: 'c'.repeat(64) }], journal: state, completions: [{ episodeId: 'turn:1', cursor: 2, endedAt: 20, digest: 'b'.repeat(64) }], updatedAt: 30,
    }
    const first = new SqliteBoardStore(path, 'fold-profile')
    first.saveSourceFold(checkpoint)
    assert.deepEqual(first.sourceFold(header.id), checkpoint)
    first.close()

    const reopened = new SqliteBoardStore(path, 'fold-profile')
    assert.deepEqual(reopened.sourceFold(header.id), checkpoint)
    reopened.deleteSourceFold(header.id)
    assert.equal(reopened.sourceFold(header.id), null)
    reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a compact incremental source cut uses only boundary and current digests', async () => {
  const { sourceCut, makeWitness } = await import('../lib/backend/workflow.js')
  const { sourcePrefixDigest } = await import('../lib/backend/event-model.js')
  const prefixDigest = 'a'.repeat(64), fromDigest = 'b'.repeat(64)
  const source = {
    sessionId: 'session-checkpoint', sourceIdentity: 'identity-a', throughCursor: 5, prefixDigests: [],
    prefixDigest, fromCursor: 2, fromDigest, completions: [], coverage: 'complete', reason: null,
  }
  assert.equal(sourcePrefixDigest(source, 2), fromDigest)
  assert.equal(sourcePrefixDigest(source, 5), prefixDigest)
  assert.equal(sourceCut(source, 5), true)
  assert.equal(sourceCut(source, 4), false)
  const card = { runtime: { cursor: 5, sync: 'synced', sourceLive: true }, workflowRevision: 7 }
  assert.deepEqual(makeWitness(card, source, null), { sourceIdentity: 'identity-a', cursor: 5, prefixDigest, workflowRevision: 7, state: null })
})

test('the compact fold builder resumes from its checkpoint without a full prefix', async () => {
  const { SourceFoldBuilder } = await import('../lib/backend/source-fold.js')
  const builder = new SourceFoldBuilder(header, 0)
  builder.append([{ seq: 0, time: 10, type: 'unknown/plugin-event', data: { value: 'a' } }])
  const first = builder.checkpoint('persistence-a', 'rev-1', 30)
  const resumed = new SourceFoldBuilder(header, 0, first)
  resumed.append([{ seq: 1, time: 20, type: 'unknown/plugin-event', data: { value: 'b' } }])
  const source = resumed.source()
  assert.equal(source.throughCursor, 2)
  assert.equal(source.fromCursor, 1)
  assert.equal(source.fromDigest, first.prefixDigest)
  assert.equal(source.prefixDigests.length, 0)
  assert.match(source.prefixDigest, /^[a-f0-9]{64}$/)
  assert.throws(() => SourceFoldBuilder.restore({ ...header, id: 'other' }, 0, first), /does not match/)
})
