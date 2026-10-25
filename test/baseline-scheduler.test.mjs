import test from 'node:test'
import assert from 'node:assert/strict'
import { BaselineScheduler } from '../lib/backend/baseline-scheduler.js'

function fakeClock() {
  let now = 0
  let sequence = 0
  const tasks = new Map()
  const timers = {
    set(callback, delay) { const id = ++sequence; tasks.set(id, { at: now + delay, callback }); return id },
    clear(id) { tasks.delete(id) },
  }
  const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
  const advance = async ms => {
    const end = now + ms
    for (;;) {
      let next
      for (const entry of tasks) if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry
      if (next === undefined) break
      tasks.delete(next[0])
      now = next[1].at
      next[1].callback()
      await settle()
    }
    now = end
  }
  return { now: () => now, timers, advance, spend: ms => { now += ms }, settle, pending: () => tasks.size }
}

test('the scheduler runs one slice at a time and respects the 20% duty cycle', async () => {
  const clock = fakeClock(), checkpoints = []
  let active = 0, maxActive = 0, slices = 0
  const scheduler = new BaselineScheduler({
    now: clock.now, timers: clock.timers, sliceMs: 20, budgetMs: 200, windowMs: 1_000, yieldMs: 50,
    runSlice: async () => {
      assert.equal(active, 0, 'a second slice must not start while one is in flight')
      active += 1; maxActive = Math.max(maxActive, active); slices += 1
      await Promise.resolve()
      clock.spend(20)
      active -= 1
      return slices >= 10 ? 'done' : 'more'
    },
    checkpoint: () => { checkpoints.push(slices) },
  })
  scheduler.enqueue('a')
  await clock.settle()
  assert.equal(maxActive, 1)
  assert.equal(scheduler.state.usedMs, 20)
  await clock.advance(1_000)
  assert.equal(slices, 10, '10 x 20ms slices is exactly the 200ms budget')
  assert.equal(checkpoints.length, 10, 'each slice is checkpointed')
  assert.equal(scheduler.state.running, false)
  scheduler.close()
})

test('a second job waits until the first one finishes', async () => {
  const clock = fakeClock(), order = []
  const scheduler = new BaselineScheduler({
    now: clock.now, timers: clock.timers, sliceMs: 20, budgetMs: 200, windowMs: 1_000, yieldMs: 50,
    runSlice: async job => { order.push(job); await Promise.resolve(); return 'done' },
    checkpoint: () => {},
  })
  scheduler.enqueue('first'); scheduler.enqueue('second')
  await clock.settle(); await clock.advance(500); await clock.settle()
  assert.deepEqual(order, ['first', 'second'])
  scheduler.close()
})

test('cancelling a queued job never starts it, and cancelling the active job stops checkpoints', async () => {
  const clock = fakeClock(), seen = [], saved = []
  const scheduler = new BaselineScheduler({
    now: clock.now, timers: clock.timers, sliceMs: 20, budgetMs: 200, windowMs: 1_000, yieldMs: 50,
    runSlice: async job => { seen.push(job); await Promise.resolve(); return 'more' },
    checkpoint: job => { saved.push(job) },
  })
  scheduler.enqueue('a'); scheduler.enqueue('b')
  await clock.settle()
  assert.equal(scheduler.cancel('b'), true)
  assert.equal(scheduler.cancel('a'), true)
  const before = saved.length
  await clock.advance(2_000)
  assert.deepEqual(seen, ['a'])
  assert.equal(saved.length, before, 'an in-flight cancelled slice is not checkpointed')
  assert.equal(scheduler.state.active, false)
  scheduler.close()
})

test('pause and resume stop and restart scheduling', async () => {
  const clock = fakeClock(), seen = []
  const scheduler = new BaselineScheduler({
    now: clock.now, timers: clock.timers, sliceMs: 20, budgetMs: 200, windowMs: 1_000, yieldMs: 50,
    runSlice: async job => { seen.push(job); await Promise.resolve(); return 'more' },
    checkpoint: () => {},
  })
  scheduler.enqueue('a'); await clock.settle()
  const afterFirst = seen.length
  scheduler.pause()
  await clock.advance(2_000)
  assert.equal(seen.length, afterFirst)
  scheduler.resume()
  await clock.advance(1_000)
  assert(seen.length > afterFirst)
  scheduler.close()
})

test('a failed slice drops the job instead of retrying forever', async () => {
  const clock = fakeClock(), failures = []
  const scheduler = new BaselineScheduler({
    now: clock.now, timers: clock.timers, sliceMs: 20, budgetMs: 200, windowMs: 1_000, yieldMs: 50,
    runSlice: async () => { throw new Error('boom') },
    checkpoint: () => {},
    failed: (job, error) => failures.push([job, error instanceof Error ? error.message : String(error)]),
  })
  scheduler.enqueue('a'); await clock.settle(); await clock.advance(1_000)
  assert.deepEqual(failures, [['a', 'boom']])
  assert.equal(scheduler.state.active, false)
  scheduler.close()
})
