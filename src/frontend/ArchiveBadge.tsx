import type { Card } from '../shared/model.js'
import { useTranslator } from './i18n.js'
import { hostArchiveText } from './view-model.js'

export function ArchiveBadge({ value, showActive = false }: { value: Card['hostArchive']; showActive?: boolean }) {
  const t = useTranslator()
  if (value.state === 'active' && !showActive) return null
  return <span className="sd-badge" data-host-archive={value.state} title={value.reason ?? undefined}>{hostArchiveText(value, t)}</span>
}
