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
/** A small disclosure chevron; a path instead of a text glyph so it renders the
 *  same in every font (the isolated fixture only ships a CJK subset). */
export function CaretIcon({ className = 'sd-caret' }: { className?: string }) {
  return <svg className={className} aria-hidden="true" focusable="false" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7"/></svg>
}
/** The drag handle: six dots as a path, so it never depends on a font shipping
 *  the braille pattern glyph. */
export function GripIcon({ className = 'sd-grip' }: { className?: string }) {
  return <svg className={className} aria-hidden="true" focusable="false" width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>
}
