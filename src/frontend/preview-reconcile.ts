/** The preview frame opens its target immediately and then verifies it exactly
 *  twice: one second and two seconds after the navigation request. DSH finishes
 *  its own boot restore inside that window; afterwards the frame belongs to the
 *  reader, who may follow a subagent link without being pulled back. */
export const PREVIEW_RECONCILE_CHECKPOINTS_MS = [1_000, 2_000] as const
export const PREVIEW_RECONCILE_MS = PREVIEW_RECONCILE_CHECKPOINTS_MS[1]

/** Injectable timer seam: production uses the host window, tests use fake time. */
export interface PreviewReconcileTimers {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

const environmentTimers: PreviewReconcileTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface PreviewReconcileOptions {
  /** Navigate the native page to the Session. Returns false while the native
   *  catalogue does not contain it yet, so a later catalogue event may finish
   *  that first open; it is never retried once the open has succeeded. */
  open(sessionId: string): boolean
  /** The Session the native page is currently rendering, if known. */
  shown(): string | null
  /** Defaults to PREVIEW_RECONCILE_CHECKPOINTS_MS. */
  checkpoints?: readonly number[]
  timers?: PreviewReconcileTimers
}

export interface PreviewReconciler {
  /** Open the target now (a cold frame needs it) and schedule the two checks. */
  start(sessionId: string): void
  /** An explicit parent request for the current target: navigate unless it is
   *  already shown, without restarting the startup checks. */
  requestOpen(): void
  /** The catalogue changed: only finish a first open that has not succeeded. */
  catalogueChanged(): void
  /** Stop every pending check; the frame keeps whatever it shows. */
  dispose(): void
}

/** Post-boot reconciliation for one preview frame. The controller never polls
 *  and never reopens an already successful navigation, so a reader who switches
 *  to a subagent after the last checkpoint stays there. */
export function createPreviewReconciler(options: PreviewReconcileOptions): PreviewReconciler {
  const timers = options.timers ?? environmentTimers
  const checkpoints = options.checkpoints ?? PREVIEW_RECONCILE_CHECKPOINTS_MS
  let target: string | null = null
  let handles: unknown[] = []
  let opened = false
  let navigating = false
  let done = true

  const clearTimers = () => {
    for (const handle of handles) timers.clear(handle)
    handles = []
  }
  const finish = () => {
    done = true
    clearTimers()
  }
  const attempt = (): boolean => {
    if (target === null) return false
    // openSession republishes retention synchronously in DSH. Ignore that
    // re-entrant catalogue event instead of recursing into a second open.
    navigating = true
    let openedNow = false
    try {
      openedNow = options.open(target)
    } finally {
      navigating = false
    }
    if (openedNow) opened = true
    return openedNow
  }

  return {
    start(sessionId: string) {
      clearTimers()
      target = sessionId
      opened = false
      done = false
      // Cold boot: reveal the target at once. The checkpoints only repair a
      // native restore that lands after this first navigation.
      attempt()
      handles = checkpoints.map((delay, index) => {
        const last = index === checkpoints.length - 1
        return timers.set(() => {
          if (done || target === null) return
          if (options.shown() === target) opened = true
          else attempt()
          if (last) finish()
        }, delay)
      })
    },
    requestOpen() {
      if (target === null) return
      if (options.shown() === target) { opened = true; return }
      attempt()
    },
    catalogueChanged() {
      if (done || navigating || target === null) return
      if (options.shown() === target) { opened = true; return }
      // Catalogue arrival is the one event allowed to finish the initial open;
      // once it succeeded, later events must not drag the reader back.
      if (!opened) attempt()
    },
    dispose() {
      finish()
      target = null
    },
  }
}
