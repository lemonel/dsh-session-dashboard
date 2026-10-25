/** One global cooperative baseline worker. It never runs two slices at once and
 *  keeps a hard wall-clock budget per slice plus a rolling duty-cycle budget, so a
 *  long first baseline cannot monopolise the DSH event loop. Callers must make
 *  `runSlice` itself cooperative (an event/byte chunk, never a whole log). */
export type BaselineSliceResult = 'more' | 'done'

export interface BaselineTimers {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

export interface BaselineSchedulerOptions<T> {
  /** Process one bounded chunk and return whether more work remains. */
  runSlice(job: T, budgetMs: number): Promise<BaselineSliceResult>
  /** Persist the resumable checkpoint after a slice. Included in the budget. */
  checkpoint(job: T): Promise<void> | void
  /** Called when a slice throws; the job is removed unless the callback requeues it. */
  failed?(job: T, error: unknown): void
  now?(): number
  timers?: BaselineTimers
  /** Hard per-slice wall-clock ceiling. Default 20ms. */
  sliceMs?: number
  /** Work budget per rolling window. Default 200ms (20% of one core). */
  budgetMs?: number
  /** Duty-cycle window. Default 1000ms. */
  windowMs?: number
  /** Idle gap between slices while budget remains. Default 50ms. */
  yieldMs?: number
  /** Upper bound on queued jobs; enqueue returns false when full. */
  capacity?: number
}

export interface BaselineSchedulerState {
  queued: number
  running: boolean
  active: boolean
  usedMs: number
  budgetMs: number
  closed: boolean
}

const defaultTimers: BaselineTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class BaselineScheduler<T> {
  private readonly queue: T[] = []
  private readonly cancelled = new Set<T>()
  private active: T | null = null
  private running = false
  private timer: unknown = null
  private windowStart = 0
  private used = 0
  private closed = false
  private paused = false
  private readonly now: () => number
  private readonly timers: BaselineTimers
  private readonly sliceMs: number
  private readonly budgetMs: number
  private readonly windowMs: number
  private readonly yieldMs: number
  private readonly capacity: number

  constructor(private readonly options: BaselineSchedulerOptions<T>) {
    this.now = options.now ?? (() => performance.now())
    this.timers = options.timers ?? defaultTimers
    this.sliceMs = positive(options.sliceMs, 20)
    this.budgetMs = positive(options.budgetMs, 200)
    this.windowMs = positive(options.windowMs, 1_000)
    this.yieldMs = nonNegative(options.yieldMs, 50)
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 256))
    this.windowStart = this.now()
  }

  get state(): BaselineSchedulerState {
    return { queued: this.queue.length, running: this.running, active: this.active !== null, usedMs: this.used, budgetMs: this.budgetMs, closed: this.closed }
  }

  /** Queue a job. Returns false only when closed or the queue is full. */
  enqueue(job: T): boolean {
    if (this.closed || this.queue.length >= this.capacity) return false
    this.queue.push(job)
    this.cancelled.delete(job)
    this.pump()
    return true
  }

  /** Cancel a queued job, or ask the active slice to stop after it returns. */
  cancel(job: T): boolean {
    const at = this.queue.indexOf(job)
    if (at >= 0) { this.queue.splice(at, 1); return true }
    if (this.active === job) { this.cancelled.add(job); return true }
    return false
  }

  /** Pause between slices. An in-flight slice is never interrupted. */
  pause(): void {
    this.paused = true
    this.clearTimer()
  }

  resume(): void {
    if (this.closed || !this.paused) return
    this.paused = false
    this.pump()
  }

  /** Stop scheduling. An in-flight slice may still finish; no checkpoint is added
   *  after an active cancellation. */
  close(): void {
    this.closed = true
    this.paused = false
    this.queue.splice(0)
    this.clearTimer()
    if (this.active !== null) this.cancelled.add(this.active)
    this.active = null
  }

  private pump(): void {
    if (this.closed || this.paused || this.running) return
    if (this.active === null) {
      this.active = this.queue.shift() ?? null
      if (this.active === null) return
    }
    if (this.cancelled.has(this.active)) {
      this.active = null
      this.pump()
      return
    }
    const now = this.now()
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now
      this.used = 0
    }
    const remaining = this.budgetMs - this.used
    if (remaining <= 0) {
      this.schedule(Math.max(0, this.windowStart + this.windowMs - now))
      return
    }
    const job = this.active
    const started = now
    this.running = true
    void (async () => {
      let result: BaselineSliceResult | null = null
      try {
        result = await this.options.runSlice(job, Math.min(this.sliceMs, remaining))
        if (!this.cancelled.has(job) && !this.closed) await this.options.checkpoint(job)
      } catch (error) {
        if (!this.closed) this.options.failed?.(job, error)
        result = null
      } finally {
        const spent = Math.max(0, this.now() - started)
        this.used += Math.min(spent, remaining)
        this.running = false
      }
      if (this.closed || this.cancelled.has(job)) {
        this.cancelled.delete(job)
        if (this.active === job) this.active = null
        this.pump()
        return
      }
      if (result === null) {
        if (this.active === job) this.active = null
        this.schedule(this.yieldMs)
        return
      }
      if (result === 'done') {
        if (this.active === job) this.active = null
        this.schedule(0)
        return
      }
      const left = this.budgetMs - this.used
      if (left <= 0) {
        this.schedule(Math.max(0, this.windowStart + this.windowMs - this.now()))
        return
      }
      this.schedule(this.yieldMs)
    })()
  }

  private schedule(delay: number): void {
    if (this.closed || this.paused || this.timer !== null) return
    this.timer = this.timers.set(() => {
      this.timer = null
      this.pump()
    }, Math.max(0, delay))
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.timers.clear(this.timer)
    this.timer = null
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
