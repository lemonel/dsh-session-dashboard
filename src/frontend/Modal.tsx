import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslator } from './i18n.js'

interface ModalProps { title: string; children: ReactNode; onClose: () => void; drawer?: boolean; busy?: boolean; wide?: boolean; originId?: string }
/** The top dialog owns Tab/Escape. Nested confirmation returns focus to the drawer. */
export function Modal({ title, children, onClose, drawer = false, busy = false, wide = false, originId: explicitOrigin }: ModalProps) {
  const t = useTranslator()
  const id = useId()
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose); close.current = onClose
  const working = useRef(busy); working.current = busy
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = ref.current
    if (!panel) return
    const originCard = previous?.closest<HTMLElement>('[data-card-id]')
    const originId = originCard?.dataset.cardId
    const cards = [...document.querySelectorAll<HTMLElement>('[data-card-id]')]
    const originIndex = originCard ? cards.indexOf(originCard) : -1
    const neighboringIds = originIndex < 0 ? [] : [...cards.slice(originIndex + 1), ...cards.slice(0, originIndex).reverse()].map(card => card.dataset.cardId)
    const focusCard = (id: string | undefined): boolean => {
      if (!id) return false
      const card = [...document.querySelectorAll<HTMLElement>('[data-card-id]')].find(item => item.dataset.cardId === id && !item.closest('[hidden]'))
      if (!card) return false
      const target = card.matches('button,[tabindex]') ? card : card.querySelector<HTMLElement>('button,[tabindex]')
      if (!target) return false
      target.focus(); return true
    }
    const initial = panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])')
    ;(initial ?? panel).focus()
    const keydown = (event: KeyboardEvent) => {
      const dialogs = [...document.querySelectorAll('[data-sd-dialog]')]
      if (dialogs[dialogs.length - 1] !== panel) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!working.current) close.current()
      }
      if (event.key !== 'Tab') return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')].filter(node => !node.hidden && !node.closest('[hidden]'))
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first) { event.preventDefault(); panel.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); (last ?? first).focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      // A re-render during the dialog's life (for example a confirmed round moving
      // between columns) can leave document.body as the captured origin; restoring
      // there would silently drop keyboard focus, so resolve the card by identity.
      const restore = previous !== null && previous !== document.body && previous !== document.documentElement ? previous : null
      if (restore?.isConnected) restore.focus()
      else if (!focusCard(explicitOrigin ?? originId) && !neighboringIds.some(focusCard)) {
        // Never steal focus that another dialog or the owner already restored.
        const active = document.activeElement
        if (active === null || active === document.body || active === document.documentElement) document.querySelector<HTMLElement>('[data-sd-home]')?.focus()
      }
    }
  }, [])
  return <div className={`sd-overlay${drawer ? ' sd-drawer-overlay' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={ref} data-sd-dialog data-wide={wide ? 'true' : undefined} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={`sd-modal${drawer ? ' sd-drawer' : ''}`}>
      {/* The drawer scrolls; keeping its title and close affordance on the surface forms a persistent header. */}
      <div className="sd-modal-head" data-sticky={drawer ? 'true' : undefined}><h2 id={id}>{title}</h2><button type="button" className="sd-icon-btn" aria-label={t('close', { title })} onClick={onClose} disabled={busy}>×</button></div>
      {children}
    </section>
  </div>
}

export function ConfirmDialog({ title, message, confirmText, busy, confirmDisabled = false, onConfirm, onClose, danger = false, children }: {
  title: string; message: string; confirmText?: string; busy: boolean; confirmDisabled?: boolean; onConfirm: () => void; onClose: () => void; danger?: boolean; children?: ReactNode
}) {
  const t = useTranslator()
  return <Modal title={title} onClose={onClose} busy={busy}>
    <div className="sd-stack"><p>{message}</p>{children}</div>
    <div className="sd-modal-foot"><button onClick={onClose} disabled={busy}>{t('cancel')}</button><button className={danger ? 'sd-danger' : 'sd-primary'} onClick={onConfirm} disabled={busy || confirmDisabled}>{busy ? t('submitting') : confirmText ?? t('confirm')}</button></div>
  </Modal>
}
