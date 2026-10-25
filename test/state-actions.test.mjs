import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptState } from '../lib/frontend/state-actions.js'
import { emptyBoard, unknownRuntime } from '../lib/shared/model.js'

function card(status) {
  return {
    sessionId: 'a', membershipId: '11111111-1111-4111-8111-111111111111', hostArchive: { state: 'active', reason: null },
    hostTitle: 'A', titleOverride: null, workspace: '/workspace', projectId: null, tagIds: [], progress: '',
    status, placement: { kind: 'builtin', status }, origin: null, placementWitness: null, workflowRevision: 3,
    runtime: { ...unknownRuntime(), sync: 'synced', phase: 'completed', episodeId: 'turn:1', episodeOrder: 1, endedAt: 2, cursor: 4, sourceLive: true, attention: 'none', fingerprint: 'cut' },
    decision: null, joinedAt: 1, activityAt: 2, updatedAt: 2, reviewAt: 2, acceptedAt: null, archivedAt: null,
    metadataRevision: 1, lifecycleRevision: 3,
  }
}

test('D01 accepting a 待确认 round goes straight to one atomic review into the chosen status', async () => {
  const board = emptyBoard()
  board.statuses = [{ id: 's1', name: '开发', color: null, createdAt: 1, revision: 0 }]
  board.orders.status.ids = ['in_progress', 'pending_confirm', 'pending_review', 'accepted', 's1']
  board.cards = [card('pending_confirm')]
  const calls = []
  const client = {
    getSnapshot: () => ({ snapshot: { board, health: { state: 'ready', message: null, lastSyncAt: 2 } }, handshake: { serviceId: 'svc' }, serviceChanged: false, transportError: null }),
    noticeKey: () => {},
    mutate: async command => {
      calls.push(command)
      if (command.type === 'review') {
        board.cards = [{ ...card('accepted'), placement: { kind: 'custom', statusId: 's1' }, decision: { kind: 'accepted', episodeId: 'turn:1', at: 3 } }]
        return { board }
      }
      return null
    },
  }
  assert.equal(await acceptState(client, board.cards[0], 's1'), true)
  assert.deepEqual(calls.map(command => command.type), ['review'], 'a failed acceptance cannot leave an intermediate confirm behind')
  assert.equal(calls[0].action, 'accept')
  assert.equal(calls[0].expectedLifecycleRevision, 3, 'the pending-confirm binding is used directly')
  assert.deepEqual(calls[0].destination, { kind: 'custom', target: { statusId: 's1', expectedStatusRevision: 0 } })
})
