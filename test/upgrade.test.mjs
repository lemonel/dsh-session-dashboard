import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowBinding } from './helpers.mjs'
import { join } from 'node:path'
import { TYPERT as GOAL_TYPERT } from '@deepseek-ai/dsh-goal/typert'
import { SqliteBoardStore } from '../lib/backend/store.js'
import { profileBinding } from '../lib/backend/config.js'
import { executionWorkspace, denyNetwork, prompt, textResponse, toolResponse, eventsOf } from './tools/execution-host.mjs'

const ref = goal => ({ id: goal.id, revision: goal.revision })
const stale = error => error.code === 'dashboard/error' && error.details.reason === 'REVIEW_STALE'

test('0.1.0 persisted Goal clear/edited-time defects heal from exact JSONL facts without schema migration or lost decisions', { timeout: 30000 }, async t => {
  denyNetwork(t)
  for (const disposition of ['pending', 'accepted', 'returned', 'reopened']) {
    const workspace = await executionWorkspace(t), first = await workspace.start({ goals: true })
    first.registerTool('finish_upgrade_goal', async (_args, exec) => {
      const goal = first.ctx.goals.create(exec.agent, { objective: 'A durable pre-upgrade result' })
      first.ctx.goals.complete(exec.agent, ref(goal)); return 'Goal completed'
    })
    first.adapter.enqueue(toolResponse('finish_upgrade_goal'), textResponse('Real complete output before upgrade'))
    const agent = await first.create(`upgrade-${disposition}`)
    await first.add(agent.id); prompt(agent); await agent.whenIdle()
    if (disposition === 'accepted' || disposition === 'reopened') await first.review(agent.id)
    if (disposition === 'returned') await first.review(agent.id, 'return')
    if (disposition === 'reopened') await first.review(agent.id, 'reopen')
    const reliable = await first.card(agent.id)
    first.ctx.typert.register(GOAL_TYPERT)
    const invoke = (method, args) => first.ctx.typertGateway.invoke({ namespace: 'goals', method, args: { agentId: agent.id, ...args }, peer: first.peer })
    await invoke('edit', { ref: ref(first.ctx.goals.get(agent)), request: { objective: 'Only rename the already completed definition' } })
    const edit = eventsOf(await first.readEvents(agent.id), 'goal/change').at(-1)
    await invoke('clear', { ref: ref(first.ctx.goals.get(agent)) })
    const durableEvents = await first.readEvents(agent.id)
    await first.close()

    // Reproduce the *persisted format* left by the 0.1.0 bug, not a new migration
    // or a forged host event. Host JSONL is untouched. Old clear withdrew sync
    // and retained a stale cursor; old edit stamped the wrong pending time.
    const store = new SqliteBoardStore(join(workspace.root, 'dashboard/dashboard.sqlite'), profileBinding(workspace.root))
    let old
    try {
      store.commit(null, board => {
        const card = board.cards.find(value => value.sessionId === agent.id)
        card.runtime = { ...reliable.runtime, sync: 'unknown', sourceLive: false,
          fingerprint: 'legacy-0.1.0-goal-metadata-fingerprint',
          endedAt: disposition === 'pending' ? edit.time : reliable.runtime.endedAt,
          explanation: '同轮终态与当前阶段不一致，保留已确认结果并等待重新同步' }
        card.reviewAt = disposition === 'pending' ? edit.time : null
        card.lifecycleRevision += 1
        return true
      })
      old = store.read().cards[0]
      assert.equal(store.read().schemaVersion, 11)
    } finally { store.close() }
    const checked = { type: 'review', ...workflowBinding(old), action: 'accept', confirmed: true, destination: { kind: 'stay' } }

    const next = await workspace.start({ goals: true })
    const cold = (await next.sync(agent.id)).board.cards[0]
    assert.equal(cold.runtime.sourceLive, false)
    await assert.rejects(next.mutate(checked), stale)
    await next.create(agent.id, true)
    const healed = (await next.sync(agent.id)).board.cards[0]
    assert.equal(healed.runtime.sync, 'synced'); assert.equal(healed.runtime.sourceLive, true)
    const afterResumeEvents = await next.readEvents(agent.id)
    assert.equal(healed.runtime.phase, 'completed'); assert.equal(healed.runtime.cursor, afterResumeEvents.length)
    assert(afterResumeEvents.length >= durableEvents.length, 'host resume may append real configuration metadata')
    assert.equal(eventsOf(afterResumeEvents, 'turn/start').length, eventsOf(durableEvents, 'turn/start').length)
    assert.equal(eventsOf(afterResumeEvents, 'step/start').length, eventsOf(durableEvents, 'step/start').length)
    assert.equal(healed.runtime.episodeId, reliable.runtime.episodeId)
    assert.equal(healed.runtime.endedAt, reliable.runtime.endedAt)
    assert.equal(healed.status, reliable.status); assert.deepEqual(healed.decision, reliable.decision)
    assert.equal(healed.reviewAt, reliable.reviewAt); assert.equal(healed.acceptedAt, reliable.acceptedAt)
    assert(healed.lifecycleRevision > old.lifecycleRevision, 'upgrade must invalidate the old unreliable review binding once')
    assert.equal((await next.sync(agent.id)).board.cards[0].lifecycleRevision, healed.lifecycleRevision, 'repeat sync is stable')
    assert.equal(next.adapter.requests.length, 0, 'upgrade never wakes new model work')
    await assert.rejects(next.mutate(checked), stale)
    if (disposition === 'pending') {
      await next.review(agent.id)
      assert.equal((await next.card(agent.id)).status, 'accepted')
    }
    await next.close()
  }
})
