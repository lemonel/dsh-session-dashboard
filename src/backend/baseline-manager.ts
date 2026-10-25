import { BaselineScheduler, type BaselineSchedulerOptions, type BaselineTimers, type BaselineSliceResult } from './baseline-scheduler.js'
import { SourceFoldBuilder } from './source-fold.js'
import type { BoardStore, SourceFoldCheckpoint } from './store.js'
import type { HostPort, HostSourceSlice } from './host-port.js'
import type { SourceReplay } from './event-model.js'
import { sourceHeaderDigest } from './lifecycle.js'
import { errorText } from '../shared/commands.js'

export type BaselineState = 'idle' | 'running' | 'ready' | 'unavailable'

export interface BaselineProgress {
  state: BaselineState
  cursor: number
  total: number | null
  reason: string | null
}

/** A source cut for a caller. `ready` means the compact proof reaches at least
 *  the requested cursor; a caller that needs the live end passes the session seq. */
export interface BaselineSource {
  state: 'ready' | 'running' | 'unavailable'
  source: SourceReplay | null
  cursor: number
  total: number | null
  reason: string | null
}

export interface BaselineManagerOptions {
  now?(): number
  timers?: BaselineTimers
  sliceMs?: number
  budgetMs?: number
  windowMs?: number
  yieldMs?: number
  /** Events folded per bounded durable read. */
  batchEvents?: number
  /** One inline attempt for short sessions before the background worker takes over. */
  inlineMs?: number
  retryMs?: number
  onProgress?(sessionId: string): void
}

interface BaselineJob {
  readonly sessionId: string
  builder: SourceFoldBuilder | null
  checkpoint: SourceFoldCheckpoint | null
  checkpointLoaded: boolean
  busy: boolean
  scheduled: boolean
  caughtUp: boolean
  cursor: number
  total: number | null
  revision: string
  persistenceIdentity: string
  archiveVersion: { sourceId: string; revision: number } | null
  error: string | null
  /** Active user mutations hold the session; background slices pause and resume after. */
  userHolds: number
  resumeAfterHold: boolean
  retryAt: number
  progressAt: number
}

/** Resumable, chunked source baselines. The scheduler is the only background
 *  writer; an inline short-session fold runs before a job is ever queued. Every
 *  chunk is persisted as a compact checkpoint so a restart resumes at its exact
 *  cursor instead of re-reading a multi-megabyte log. */
export class BaselineManager {
  private readonly jobs = new Map<string, BaselineJob>()
  private readonly scheduler: BaselineScheduler<BaselineJob>
  private readonly now: () => number
  private readonly batchEvents: number
  private readonly inlineMs: number
  private readonly retryMs: number
  private readonly onProgress: (sessionId: string) => void
  private closed = false

  constructor(private readonly host: HostPort, private readonly store: BoardStore, options: BaselineManagerOptions = {}) {
    this.now = options.now ?? (() => performance.now())
    this.batchEvents = positive(options.batchEvents, 500)
    this.inlineMs = positive(options.inlineMs, 100)
    this.retryMs = positive(options.retryMs, 5000)
    this.onProgress = options.onProgress ?? (() => {})
    const schedulerOptions: BaselineSchedulerOptions<BaselineJob> = {
      runSlice: (job, budget) => this.runSlice(job, budget),
      checkpoint: job => this.checkpoint(job),
      failed: (job, error) => this.failed(job, error),
      now: this.now,
      timers: options.timers,
      sliceMs: Math.min(100, positive(options.sliceMs, 20)),
      budgetMs: options.budgetMs,
      windowMs: options.windowMs,
      yieldMs: options.yieldMs,
      capacity: 512,
    }
    this.scheduler = new BaselineScheduler(schedulerOptions)
  }

  /** Cheap state for an inline UI row. No host or log read. */
  status(sessionId: string): BaselineProgress {
    const job = this.jobs.get(sessionId)
    if (!job) return { state: 'idle', cursor: 0, total: null, reason: null }
    const cursor = job.builder?.cursor ?? job.checkpoint?.cursor ?? job.cursor
    if (job.error !== null) return { state: 'unavailable', cursor, total: job.total, reason: job.error }
    if (job.caughtUp) return { state: 'ready', cursor, total: job.total, reason: null }
    if (job.scheduled || job.busy) return { state: 'running', cursor, total: job.total, reason: null }
    return { state: 'idle', cursor, total: job.total, reason: null }
  }

  /** Pause background work for a user mutation. The returned release resumes the
   *  worker. Inline source reads for the mutation itself remain allowed. */
  async hold(sessionId: string): Promise<() => void> {
    if (this.closed) return () => {}
    const job = this.jobFor(sessionId)
    const resume = job.scheduled || job.busy
    job.userHolds += 1
    if (job.scheduled && !job.busy) { this.scheduler.cancel(job); job.scheduled = false }
    const until = this.now() + 150
    while (job.busy && this.now() < until) await new Promise(resolve => setTimeout(resolve, 2))
    let released = false
    return () => {
      if (released) return
      released = true
      job.userHolds = Math.max(0, job.userHolds - 1)
      if (job.userHolds === 0 && !this.closed && (resume || job.resumeAfterHold)) { job.resumeAfterHold = false; this.schedule(job) }
    }
  }

  /** Ask the single worker to catch this session up to its durable end. */
  ensure(sessionId: string): void {
    if (this.closed) return
    const job = this.jobFor(sessionId)
    if (job.error !== null && this.now() >= job.retryAt) { job.error = null }
    if (job.error !== null) return
    this.schedule(job)
  }

  /** Return a source cut reaching at least `minCursor`. Short tails are folded
   *  inline; a long first baseline returns `running` and continues in the worker.
   *  `minCursor` should be the observation cursor for a user operation. */
  async source(sessionId: string, minCursor = 0): Promise<BaselineSource> {
    if (this.closed) return { state: 'unavailable', source: null, cursor: 0, total: null, reason: '仪表板已关闭' }
    if (!Number.isSafeInteger(minCursor) || minCursor < 0) minCursor = 0
    const job = this.jobFor(sessionId)
    if (job.error !== null && this.now() >= job.retryAt) { job.error = null }
    if (job.error !== null) return this.result(job, 'unavailable')
    if (job.builder !== null && job.builder.cursor >= minCursor) return this.ready(job, minCursor)
    if (job.busy) {
      // A user operation gets the current short slice, then folds the remaining
      // tail inline rather than reporting a running baseline it could finish.
      const until = this.now() + this.inlineMs
      while (job.busy && this.now() < until) await new Promise(resolve => setTimeout(resolve, 2))
      if (job.busy) return this.result(job, 'running')
    }
    const deadline = this.now() + this.inlineMs
    for (let slice = 0; slice < 64; slice += 1) {
      if (this.closed) return { state: 'unavailable', source: null, cursor: job.cursor, total: job.total, reason: '仪表板已关闭' }
      const current = job.builder?.cursor ?? job.checkpoint?.cursor ?? 0
      const step = await this.step(job, minCursor > current ? minCursor - current : undefined)
      if (step === 'error') return this.result(job, 'unavailable')
      if (job.builder !== null && job.builder.cursor >= minCursor) {
        try { await this.checkpoint(job) } catch (error) { this.failed(job, error); return this.result(job, 'unavailable') }
        this.settle(job)
        return this.ready(job, minCursor)
      }
      if (step === 'done') {
        try { await this.checkpoint(job) } catch (error) { this.failed(job, error); return this.result(job, 'unavailable') }
        this.settle(job)
        return this.result(job, 'running')
      }
      if (this.now() >= deadline) break
    }
    try { await this.checkpoint(job) } catch (error) { this.failed(job, error); return this.result(job, 'unavailable') }
    this.schedule(job)
    return this.result(job, 'running')
  }

  /** Source only if it already reaches `minCursor`; never performs I/O. */
  peek(sessionId: string, minCursor = 0): SourceReplay | null {
    const job = this.jobs.get(sessionId)
    if (!job || job.builder === null || job.error !== null || job.builder.cursor < minCursor) return null
    const source = job.builder.sourceAt(minCursor)
    return source === null ? null : withArchive(source, job.archiveVersion)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.scheduler.close()
    this.jobs.clear()
  }

  private jobFor(sessionId: string): BaselineJob {
    let job = this.jobs.get(sessionId)
    if (job === undefined) {
      job = { sessionId, builder: null, checkpoint: null, checkpointLoaded: false, busy: false, scheduled: false,
        caughtUp: false, cursor: 0, total: null, revision: '', persistenceIdentity: '', archiveVersion: null, error: null, userHolds: 0, resumeAfterHold: false, retryAt: 0, progressAt: 0 }
      this.jobs.set(sessionId, job)
    }
    return job
  }

  private result(job: BaselineJob, state: BaselineSource['state']): BaselineSource {
    const cursor = job.builder?.cursor ?? job.checkpoint?.cursor ?? job.cursor
    return { state, source: state === 'ready' && job.builder !== null ? withArchive(job.builder.source(), job.archiveVersion) : null,
      cursor, total: job.total, reason: state === 'unavailable' ? job.error ?? '来源基线不可用' : null }
  }

  private ready(job: BaselineJob, minCursor: number): BaselineSource {
    const source = job.builder?.sourceAt(minCursor)
    if (source === null || source === undefined) {
      return { state: 'unavailable', source: null, cursor: job.builder?.cursor ?? 0, total: job.total,
        reason: '来源基线已越过此轮游标；请重新同步当前会话后再试' }
    }
    return { state: 'ready', source: withArchive(source, job.archiveVersion), cursor: source.throughCursor, total: job.total, reason: null }
  }

  private schedule(job: BaselineJob): void {
    if (this.closed) return
    if (job.userHolds > 0) { job.resumeAfterHold = true; return }
    if (job.scheduled || job.busy) return
    job.scheduled = this.scheduler.enqueue(job)
    if (job.scheduled) this.progress(job)
  }

  /** An inline catch-up overtook a queued slice; drop the redundant background work. */
  private settle(job: BaselineJob): void {
    if (!job.scheduled || job.busy) return
    this.scheduler.cancel(job)
    job.scheduled = false
  }

  private async runSlice(job: BaselineJob, budgetMs: number): Promise<BaselineSliceResult> {
    if (this.closed || this.jobs.get(job.sessionId) !== job) return 'done'
    if (job.userHolds > 0) { job.scheduled = false; return 'done' }
    const result = await this.step(job, undefined, budgetMs)
    // A user mutation may have arrived during the read; never start another slice
    // and never write a checkpoint while it owns the session.
    if (job.userHolds > 0) { job.scheduled = false; return 'done' }
    if (result === 'more') return 'more'
    job.scheduled = false
    if (result === 'done') this.progress(job)
    return 'done'
  }

  /** One bounded durable read plus append. Never concurrent with itself. */
  private async step(job: BaselineJob, maxEvents?: number, budgetMs?: number): Promise<'more' | 'done' | 'error'> {
    if (job.busy) return 'more'
    job.busy = true
    try {
      if (!this.host.readSourceSlice) throw new Error('当前宿主不支持分片来源读取，不能建立后台基线')
      if (!job.checkpointLoaded) { job.checkpoint = this.store.sourceFold(job.sessionId); job.checkpointLoaded = true }
      let from = job.builder?.cursor ?? job.checkpoint?.cursor ?? 0
      let limit = maxEvents === undefined ? this.batchEvents : Math.min(this.batchEvents, Math.max(0, maxEvents))
      // Keep a 20 ms slice to roughly 500 hashable events; this is the practical
      // hard boundary besides the scheduler's wall-clock accounting.
      if (budgetMs !== undefined) limit = Math.min(limit, Math.max(1, Math.floor(budgetMs * 25)))
      if (limit === 0) return 'done'
      let slice = await this.read(job.sessionId, from, limit)
      if (this.closed) return 'done'
      if (!await this.acceptHeader(job, slice)) return 'more'
      if (job.checkpoint !== null && slice.total !== null && job.checkpoint.cursor > slice.total) {
        this.reset(job)
        from = 0
        limit = this.batchEvents
        slice = await this.read(job.sessionId, 0, limit)
        if (!await this.acceptHeader(job, slice)) return 'more'
      }
      if (job.builder === null) {
        if (job.checkpoint !== null) {
          try { job.builder = SourceFoldBuilder.restore(slice.header, slice.inherited, job.checkpoint) }
          catch {
            this.store.deleteSourceFold(job.sessionId)
            job.checkpoint = null
            job.checkpointLoaded = true
            return 'more'
          }
          job.checkpoint = null
        } else {
          job.builder = new SourceFoldBuilder(slice.header, slice.inherited)
        }
      }
      if (slice.total !== null && job.builder.cursor > slice.total) {
        this.reset(job)
        return 'more'
      }
      // A checkpoint restored at this cursor means the read starts exactly there.
      if (slice.events.length > 0 && slice.events[0]?.seq !== job.builder.cursor) {
        this.reset(job)
        return 'more'
      }
      job.builder.append(slice.events)
      job.cursor = job.builder.cursor
      job.revision = slice.revision
      job.persistenceIdentity = slice.persistenceIdentity
      job.archiveVersion = slice.archiveVersion
      job.total = slice.total
      const done = slice.events.length === 0 || slice.total !== null && job.cursor >= slice.total
      job.caughtUp = done
      if (done) this.progress(job)
      return done ? 'done' : 'more'
    } catch (error) {
      this.failed(job, error)
      return 'error'
    } finally { job.busy = false }
  }

  private async read(sessionId: string, fromCursor: number, maxEvents: number): Promise<HostSourceSlice> {
    const read = this.host.readSourceSlice
    if (!read) throw new Error('当前宿主不支持分片来源读取，不能建立后台基线')
    return read.call(this.host, sessionId, fromCursor, maxEvents)
  }

  /** A session rewrite invalidates the compact hash chain, never silently extends it. */
  private async acceptHeader(job: BaselineJob, slice: HostSourceSlice): Promise<boolean> {
    const headerDigest = sourceHeaderDigest(slice.header, slice.inherited)
    if (job.builder !== null && job.builder.headerDigest !== headerDigest) {
      this.reset(job)
      return false
    }
    job.revision = slice.revision
    job.persistenceIdentity = slice.persistenceIdentity
    job.archiveVersion = slice.archiveVersion
    job.total = slice.total
    return true
  }

  private reset(job: BaselineJob): void {
    this.store.deleteSourceFold(job.sessionId)
    job.builder = null
    job.checkpoint = null
    job.checkpointLoaded = true
    job.cursor = 0
    job.total = null
    job.archiveVersion = null
    job.caughtUp = false
  }

  private async checkpoint(job: BaselineJob): Promise<void> {
    if (this.closed || job.userHolds > 0 || job.builder === null) return
    const checkpoint = job.builder.checkpoint(job.persistenceIdentity || 'host', job.revision, this.now())
    this.store.saveSourceFold(checkpoint)
    job.cursor = checkpoint.cursor
    job.checkpoint = null
    if (this.now() - job.progressAt >= 250 || job.caughtUp) this.progress(job)
  }

  private failed(job: BaselineJob, error: unknown): void {
    job.scheduled = false
    job.busy = false
    job.caughtUp = false
    job.error = errorText(error).slice(0, 1000)
    job.retryAt = this.now() + this.retryMs
    this.progress(job)
  }

  private progress(job: BaselineJob): void {
    job.progressAt = this.now()
    try { this.onProgress(job.sessionId) } catch { /* progress observers cannot break the worker */ }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
function withArchive(source: SourceReplay, archive: { sourceId: string; revision: number } | null): SourceReplay {
  return archive === null ? source : { ...source, archiveVersion: archive }
}
