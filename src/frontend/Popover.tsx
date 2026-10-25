import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** A disclosure popover for controls that are useful but not worth permanent space.
 *  The trigger keeps a stable accessible name so the rare controls remain findable;
 *  the panel unmounts when closed so hidden actions never stack duplicate names. */
export interface PopoverProps {
  /** Accessible name of both the trigger and the panel. */
  label: string
  children: ReactNode
  /** Which edge of the trigger the panel aligns to. */
  align?: 'start' | 'end'
  disabled?: boolean
  /** Action menus close after a click; filter panels stay open for multiple picks. */
  closeOnSelect?: boolean
  trigger?: ReactNode
  triggerClassName?: string
  panelClassName?: string
  /** Exposes the trigger so a dialog opened from the panel can return focus to it. */
  buttonRef?: import('react').RefObject<HTMLButtonElement>
}
export function Popover({ label, children, align = 'end', disabled = false, closeOnSelect = false, trigger, triggerClassName = 'sd-kebab', panelClassName = '', buttonRef }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null), own = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId()
  const button = buttonRef ?? own
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const away = (event: Event) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  return <div className="sd-popwrap" ref={wrap} onBlur={event => { if (!wrap.current?.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button type="button" ref={button} className={triggerClassName} aria-label={label} aria-expanded={open} aria-haspopup="true" aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>{trigger ?? <MoreIcon/>}</button>
    {open && <div className={`sd-pop ${panelClassName}`.trim()} id={id} role="group" aria-label={label} ref={panel} tabIndex={-1} data-align={align}
      onClick={event => { if (closeOnSelect && (event.target as HTMLElement).closest('button')) setOpen(false) }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus() } }}>{children}</div>}
  </div>
}
/** Three stacked dots: the conventional "there is more here" affordance. */
export function MoreIcon() {
  return <svg className="sd-more" aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.4" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="12" cy="18.6" r="1.75"/></svg>
}
export function FilterIcon() {
  return <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M4 7h16M7 12h10M10 17h4"/></svg>
}
