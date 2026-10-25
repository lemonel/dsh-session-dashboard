import { useEffect, useRef } from 'react'
import { useTranslator } from './i18n.js'

export interface ToastAction { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean }
/** One dashboard operation toast; `signature` distinguishes a repeat of the same key. */
export interface OperationToastInput {
  readonly key: string
  readonly signature: string
  readonly tone: 'status' | 'alert'
  readonly message: string
  /** Success feedback leaves on its own; alerts stay until dismissed. */
  readonly auto?: boolean
  readonly actions?: readonly ToastAction[]
  readonly onDismiss: () => void
}

/** The stack never hides the page: it is fixed, bounded and keeps four entries. */
export const MAX_OPERATION_TOASTS = 4
export const OPERATION_TOAST_MS = 5000

/** Newest first by first appearance, one entry per key, bounded at four. */
export function OperationToasts({ toasts, autoDismissMs = OPERATION_TOAST_MS }: { toasts: readonly OperationToastInput[]; autoDismissMs?: number }) {
  const t = useTranslator()
  const order = useRef(new Map<string, number>()), next = useRef(0)
  const latest = new Map<string, OperationToastInput>()
  // A repeated key updates its entry instead of stacking a duplicate.
  for (const toast of toasts) latest.set(toast.key, toast)
  const present = new Set(latest.keys())
  for (const key of [...order.current.keys()]) if (!present.has(key)) order.current.delete(key)
  for (const key of present) if (!order.current.has(key)) order.current.set(key, ++next.current)
  const ordered = [...latest.values()].sort((a, b) => (order.current.get(b.key) ?? 0) - (order.current.get(a.key) ?? 0)).slice(0, MAX_OPERATION_TOASTS)
  if (ordered.length === 0) return null
  return <div className="sd-toasts" aria-live="polite" aria-label={t('operationToasts')}>
    {ordered.map(toast => <OperationToast key={toast.key} toast={toast} autoDismissMs={autoDismissMs}/>)}
  </div>
}

function OperationToast({ toast, autoDismissMs }: { toast: OperationToastInput; autoDismissMs: number }) {
  const t = useTranslator()
  useEffect(() => {
    if (!toast.auto) return
    const timer = setTimeout(() => toast.onDismiss(), autoDismissMs)
    return () => clearTimeout(timer)
  }, [toast.key, toast.signature, toast.auto, autoDismissMs])
  return <div role={toast.tone} data-toast-key={toast.key} className={toast.tone === 'alert' ? 'sd-toast sd-error' : 'sd-toast'}>
    <p className="sd-toast-text">{toast.message}</p>
    <div className="sd-toast-actions">
      {toast.actions?.map(action => <button type="button" key={action.label} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>)}
      <button type="button" className="sd-toast-close" aria-label={t('dismissToast')} onClick={toast.onDismiss}>×</button>
    </div>
  </div>
}
