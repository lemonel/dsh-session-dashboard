import { useId } from 'react'
import { useTranslator } from './i18n.js'

/** A colour value is optional: empty means "no colour", otherwise canonical #RRGGBB. */
export const validColor = (value: string): boolean => value === '' || /^#[0-9a-fA-F]{6}$/.test(value)
export const DEFAULT_COLOR = '#6876c9'
/** A short palette that matches the dashboard's state colours and stays legible in both themes. */
export const COLOR_PRESETS = ['#4f63c8', '#3d6fb5', '#2f8f63', '#a9701a', '#c0392b', '#8e5bb8', '#0e8a9a', '#6b7280'] as const

/** Colour editing without asking people to type hex: a native palette, a hex field for
 *  precise values, quick presets, and an explicit clear action. */
export function ColorField({ label, value, onChange, disabled = false, hint }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; hint?: string }) {
  const t = useTranslator(), id = useId()
  const swatch = validColor(value) && value !== '' ? value : DEFAULT_COLOR
  return <div className="sd-colorfield">
    <span className="sd-colorlabel" id={`${id}-label`}>{label}{hint && <small>{hint}</small>}</span>
    <div className="sd-colorrow">
      <input type="color" className="sd-color" aria-label={`${label} ${t('colorPalette')}`} aria-describedby={`${id}-label`} value={swatch} disabled={disabled} onChange={event => onChange(event.target.value)}/>
      <input type="text" className="sd-colorhex" aria-label={label} maxLength={7} placeholder="#5266c9" value={value} disabled={disabled} spellCheck={false} autoComplete="off" onChange={event => onChange(event.target.value)}/>
      <button type="button" disabled={disabled || value === ''} onClick={() => onChange('')}>{t('clearColor')}</button>
    </div>
    <div className="sd-swatches" role="group" aria-label={t('colorPresets')}>
      {COLOR_PRESETS.map(color => <button type="button" key={color} className="sd-swatch" style={{ background: color }} aria-label={t('presetColor', { color })} aria-pressed={value.toLowerCase() === color} disabled={disabled} onClick={() => onChange(color)}/>) }
    </div>
    {value !== '' && !validColor(value) && <p className="sd-small sd-danger">{t('colorInvalidHint')}</p>}
  </div>
}
