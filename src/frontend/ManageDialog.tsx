import { useRef, useState } from 'react'
import { EMPTY, PROJECT_GROUP_ID, type Board, type Dimension, type Label, type Project, type TagGroup } from '../shared/model.js'
import { DashboardClient } from './client.js'
import { Modal } from './Modal.js'
import { ColorField } from './ColorField.js'
import { labels, valueText } from './view-model.js'
import { useTranslator } from './i18n.js'
import { useProjectTranslator } from './project-locales.js'

type LabelDimension = 'tag'
type Segment = 'categories' | 'tag'
interface LabelEdit { dimension: LabelDimension; label: Label }
interface StatusEdit { id: string | null; revision: number }
interface StatusDelete { id: string; name: string; revision: number }

/** A manager section starts collapsed and shows only what exists. It is a module-level
 *  component so typing in its form never remounts the inputs (an inline component
 *  would be a new type on every parent render and blur the focused field). */
function Collapsible({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className="sd-stack sd-collapsible" aria-label={title}>
    <button type="button" className="sd-collapsible-head" aria-expanded={open} onClick={onToggle}>
      <span className="sd-collapsible-caret" aria-hidden="true">▸</span><b>{title}</b>{' '}<span className="sd-small sd-muted">{summary}</span>
    </button>
    {open && <div className="sd-stack">{children}</div>}
  </section>
}

/** One place for every classification the dashboard shows: statuses (the four
 *  built-ins plus the board-wide custom list) and tags. Built-in statuses are
 *  system-owned, so they can only be ordered; custom statuses and tags stay
 *  editable. */
export function ManageDialog({ board, client, initialDimension, busy, onClose }: { board: Board; client: DashboardClient; initialDimension: Dimension; busy: boolean; onClose: () => void }) {
  const t = useTranslator(), pt = useProjectTranslator()
  const service = useRef(client.serviceId)
  const validService = () => { if (service.current !== client.serviceId) { setMessage(t('serviceChanged')); return false }; return true }
  const [segment, setSegment] = useState<Segment>(initialDimension === 'tag' ? 'tag' : 'categories')
  const [name, setName] = useState(''), [color, setColor] = useState(''), [editing, setEditing] = useState<LabelEdit | null>(null), [groupId, setGroupId] = useState('')
  const [groupName, setGroupName] = useState(''), [groupColor, setGroupColor] = useState(''), [editingGroup, setEditingGroup] = useState<TagGroup | null>(null), [deletingGroup, setDeletingGroup] = useState<TagGroup | null>(null)
  const [message, setMessage] = useState<string | null>(null), [closing, setClosing] = useState(false), [deleting, setDeleting] = useState<LabelEdit | null>(null)
  const [stateName, setStateName] = useState(''), [stateColor, setStateColor] = useState('')
  const [editingStatus, setEditingStatus] = useState<StatusEdit | null>(null), [deletingStatus, setDeletingStatus] = useState<StatusDelete | null>(null)
  const groupOf = (label: Label): TagGroup | null => {
    const id = (label as { groupId?: string | null }).groupId ?? null
    return id === null ? null : board.tagGroups.find(group => group.id === id) ?? null
  }
  const lockedLabel = (label: Label) => groupOf(label)?.builtin === true
  const reset = () => { setName(''); setColor(''); setEditing(null); setGroupId('') }
  const resetGroup = () => { setGroupName(''); setGroupColor(''); setEditingGroup(null) }
  const dirtyFor = (dimension: LabelDimension): boolean => {
    if (editing?.dimension !== dimension) return false
    const label = editing.label
    return name !== label.name || color !== (label.color ?? '') || (dimension === 'tag' && groupId !== ((label as { groupId?: string | null }).groupId ?? ''))
  }
  const groupDirty = groupName !== (editingGroup?.name ?? '') || groupColor !== (editingGroup?.color ?? '')
  const anyEdit = dirtyFor('tag') || groupDirty
  const save = async (dimension: LabelDimension) => {
    if (!name.trim() || busy || !validService()) return
    const current = editing?.dimension === dimension ? editing.label : null
    const result = await client.mutate(current
      ? { type: 'update_label', dimension, id: current.id, expectedRevision: current.revision, name, color: color || null, ...(dimension === 'tag' ? { groupId: groupId || null } : {}) }
      : { type: 'create_label', dimension, name, color: color || null, ...(dimension === 'tag' ? { groupId: groupId || null } : {}) })
    if (result) { reset(); setMessage(t('saved')) } else setMessage(t('retainedInput', { error: client.getSnapshot().error ?? t('saveFailed') }))
  }
  const saveGroup = async () => {
    if (!groupName.trim() || busy || !validService()) return
    const result = await client.mutate(editingGroup
      ? { type: 'update_tag_group', groupId: editingGroup.id, expectedRevision: editingGroup.revision, name: groupName, color: groupColor || null }
      : { type: 'create_tag_group', name: groupName, color: groupColor || null })
    if (result) { resetGroup(); setMessage(t('saved')) } else setMessage(t('retainedInput', { error: client.getSnapshot().error ?? t('saveFailed') }))
  }
  /** The project group is the builtin one: its values are the projects, so they are
   *  edited with the project commands while the tags below keep the label ones. */
  const [projectName, setProjectName] = useState(''), [projectColor, setProjectColor] = useState('')
  const [editingProject, setEditingProject] = useState<Project | null>(null), [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const resetProject = () => { setEditingProject(null); setProjectName(''); setProjectColor('') }
  const saveProject = async () => {
    if (!projectName.trim() || busy || !validService()) return
    const result = await client.mutate(editingProject
      ? { type: 'update_project', projectId: editingProject.id, expectedProjectRevision: editingProject.revision, name: projectName, color: projectColor || null, tagIds: [...editingProject.tagIds] }
      : { type: 'create_project', name: projectName, color: projectColor || null, tagIds: [] })
    if (result) { resetProject(); setMessage(t('saved')) } else setMessage(t('retainedInput', { error: client.getSnapshot().error ?? t('saveFailed') }))
  }
  const deleteProject = async (project: Project) => {
    if (busy || !validService()) return
    const result = await client.mutate({ type: 'delete_project', projectId: project.id, expectedProjectRevision: project.revision, confirmed: true })
    setDeletingProject(null)
    setMessage(result ? t('saved') : client.getSnapshot().error)
  }

  const reorder = async (dimension: LabelDimension, id: string, offset: number) => {
    if (!validService()) return
    const previous = board.orders[dimension], ids = [...previous.ids], index = ids.indexOf(id), target = index + offset
    if (index < 0 || target < 0 || target >= ids.length) return
    ids.splice(index, 1); ids.splice(target, 0, id)
    const result = await client.mutate({ type: 'reorder', dimension, ids, expectedRevision: previous.revision })
    setMessage(result ? t('orderSaved') : client.getSnapshot().error)
  }

  /** The status order mixes the four built-ins with the board-wide custom statuses.
   *  Built-ins may be reordered here but never renamed or removed. */
  interface StatusEntry { id: string; name: string; builtin: boolean; revision?: number; color?: string | null }
  const statusEntries = (): StatusEntry[] => {
    const natives: readonly string[] = ['in_progress', 'pending_confirm', 'pending_review', 'accepted']
    const custom = board.statuses.map(status => ({ id: status.id, name: status.name, builtin: false, revision: status.revision, color: status.color }))
    const byId = new Map(custom.map(row => [row.id, row] as const))
    const ordered: StatusEntry[] = []
    for (const id of board.orders.status.ids) {
      const row = byId.get(id)
      if (row) ordered.push(row)
      else if (natives.includes(id)) ordered.push({ id, name: t(id as 'in_progress'), builtin: true })
    }
    for (const row of custom) if (!ordered.some(item => item.id === row.id)) ordered.push(row)
    for (const id of natives) if (!ordered.some(item => item.id === id)) ordered.push({ id, name: t(id as 'in_progress'), builtin: true })
    return ordered
  }
  const resetStatus = () => { setEditingStatus(null); setStateName(''); setStateColor('') }
  const saveStatus = async () => {
    if (!stateName.trim() || busy || !validService()) return
    const result = await client.mutate(editingStatus?.id
      ? { type: 'update_label', dimension: 'status', id: editingStatus.id, expectedRevision: editingStatus.revision, name: stateName, color: stateColor || null }
      : { type: 'create_label', dimension: 'status', name: stateName, color: stateColor || null })
    if (result) { resetStatus(); setMessage(t('saved')) } else setMessage(t('retainedInput', { error: client.getSnapshot().error ?? t('saveFailed') }))
  }
  const deleteStatus = async () => {
    if (!deletingStatus || !validService()) return
    const result = await client.mutate({ type: 'delete_label', dimension: 'status', id: deletingStatus.id, expectedRevision: deletingStatus.revision })
    if (result) { setDeletingStatus(null); setMessage(t('saved')) } else setMessage(client.getSnapshot().error)
  }
  const reorderStatus = async (id: string, offset: number) => {
    if (!validService()) return
    const entries = statusEntries(), index = entries.findIndex(row => row.id === id), target = index + offset
    if (index < 0 || target < 0 || target >= entries.length) return
    const ids = entries.map(row => row.id)
    ids.splice(index, 1); ids.splice(target, 0, id)
    const result = await client.mutate({ type: 'reorder', dimension: 'status', ids, expectedRevision: board.orders.status.revision })
    setMessage(result ? t('orderSaved') : client.getSnapshot().error)
  }

  // Sections start collapsed: the default view only summarises what exists, and a
  // click opens the editor for that dimension.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const sectionOpen = (id: string) => openSections[id] === true
  const toggleSection = (id: string) => setOpenSections(current => ({ ...current, [id]: !current[id] }))

  const statusSection = <section className="sd-stack" aria-label={t('statusOrder')}>
    <h3>{t('statusOrder')}</h3>
    <p className="sd-small sd-muted">{t('statusOrderHint')}</p>
    <div className="sd-stack" role="list">{statusEntries().map((entry, index, entries) => <div className="sd-orderrow" key={entry.id} role="listitem"><span>{entry.color && <span className="sd-dot" style={{ background: entry.color }}/>}{entry.name}{entry.builtin && <span className="sd-small sd-muted"> · {t('builtinGroup')}</span>}</span><div className="sd-row"><button aria-label={t('movePrevious', { name: entry.name })} disabled={busy || index === 0} onClick={() => { void reorderStatus(entry.id, -1) }}>↑</button><button aria-label={t('moveNext', { name: entry.name })} disabled={busy || index === entries.length - 1} onClick={() => { void reorderStatus(entry.id, 1) }}>↓</button>{!entry.builtin && <><button disabled={busy} onClick={() => { setEditingStatus({ id: entry.id, revision: entry.revision ?? 0 }); setStateName(entry.name); setStateColor(entry.color ?? '') }}>{t('edit')}</button><button disabled={busy} onClick={() => setDeletingStatus({ id: entry.id, name: entry.name, revision: entry.revision ?? 0 })}>{t('delete')}</button></>}</div></div>)}</div>
    <form className="sd-stack" onSubmit={event => { event.preventDefault(); void saveStatus() }}>
      <h4>{t(editingStatus ? 'editStatus' : 'createStatus')}</h4>
      <label className="sd-formfield"><span>{t('name')}</span><input aria-label={t('stateName')} value={stateName} maxLength={80} disabled={busy} onChange={event => setStateName(event.target.value)}/></label>
      <ColorField label={t('labelColor')} hint={t('optionalColor')} value={stateColor} disabled={busy} onChange={setStateColor}/>
      <div className="sd-row"><button type="submit" className="sd-primary" disabled={busy || !stateName.trim()}>{t(editingStatus ? 'saveLabel' : 'createStatus')}</button><button type="button" onClick={resetStatus}>{t('discardEdit')}</button></div>
    </form>
    {deletingStatus && <div className="sd-draftbar"><p>{t('deleteStatusQuestion', { name: deletingStatus.name })}</p><button onClick={() => setDeletingStatus(null)}>{t('cancel')}</button><button disabled={busy} onClick={() => { void deleteStatus() }}>{t('confirmDelete')}</button></div>}
  </section>

  /** Projects are the builtin tag group, so they are managed here with the same
   *  shape as any other group: list, rename/colour, create, delete. */
  const projectRows = board.orders.project.ids.filter(id => id !== EMPTY).map(id => board.projects.find(project => project.id === id)).filter((project): project is Project => project !== undefined)
  const projectSection = <Collapsible title={t('projectsGroup')} summary={t('groupSummary', { groups: 1, values: board.projects.length })} open={sectionOpen('projects')} onToggle={() => toggleSection('projects')}>
    <p className="sd-small sd-muted">{t('projectsGroupHint')}</p>
    <div className="sd-stack" role="list">{board.projects.length === 0 && <p className="sd-small sd-muted">{t('noProjects')}</p>}
      {projectRows.map(project => <div className="sd-orderrow" key={project.id} role="listitem">
        <span>{project.color && <span className="sd-dot" style={{ background: project.color }}/>}{project.name}</span>
        <span className="sd-row"><button type="button" className="sd-small" disabled={busy} onClick={() => { setEditingProject(project); setProjectName(project.name); setProjectColor(project.color ?? '') }}>{t('edit')}</button>
          <button type="button" className="sd-small sd-danger" disabled={busy} onClick={() => setDeletingProject(project)}>{t('delete')}</button></span>
      </div>)}
    </div>
    <form className="sd-stack" onSubmit={event => { event.preventDefault(); void saveProject() }}>
      <h4>{t(editingProject ? 'editProject' : 'newProject')}</h4>
      <label className="sd-formfield"><span>{pt('projectName')}</span><input aria-label={pt('projectName')} value={projectName} maxLength={80} disabled={busy} onChange={event => setProjectName(event.target.value)}/></label>
      <ColorField label={pt('projectColor')} hint={t('optionalColor')} value={projectColor} disabled={busy} onChange={setProjectColor}/>
      <div className="sd-row"><button type="submit" className="sd-primary" disabled={busy || !projectName.trim()}>{pt(editingProject ? 'saveProject' : 'createProject')}</button><button type="button" disabled={busy} onClick={resetProject}>{pt('discardProject')}</button></div>
    </form>
    {deletingProject && <div className="sd-draftbar"><p>{t('deleteProjectTitle', { name: deletingProject.name })}</p><p>{t('deleteProjectHint')}</p><div className="sd-row"><button type="button" onClick={() => setDeletingProject(null)}>{t('cancel')}</button><button type="button" className="sd-danger" disabled={busy} onClick={() => { void deleteProject(deletingProject) }}>{t('confirmDeleteProject')}</button></div></div>}
  </Collapsible>

  const labelSection = (dimension: LabelDimension) => <Collapsible title={t(dimension)} summary={t('tagSummary', { groups: board.tagGroups.filter(group => board.tags.some(tag => (tag as { groupId?: string | null }).groupId === group.id)).length, values: board.tags.length })} open={sectionOpen(dimension)} onToggle={() => toggleSection(dimension)}>
    <div className="sd-stack" role="list" aria-label={t('orderTitle', { dimension: t(dimension) })}>{board.orders[dimension].ids.map((id, index, ids) => {
      const label = labels(board, dimension).find(row => row.id === id)
      return <div className="sd-orderrow" key={id} role="listitem"><span>{valueText(board, dimension, id, t)}{label && <span className="sd-small sd-muted"> · {groupOf(label)?.name ?? t('groupNone')}</span>}</span><div className="sd-row"><button aria-label={t('movePrevious', { name: valueText(board, dimension, id, t) })} disabled={busy || index === 0} onClick={() => { void reorder(dimension, id, -1) }}>↑</button><button aria-label={t('moveNext', { name: valueText(board, dimension, id, t) })} disabled={busy || index === ids.length - 1} onClick={() => { void reorder(dimension, id, 1) }}>↓</button>{label && !lockedLabel(label) && <><button disabled={busy} onClick={() => { if (dirtyFor(dimension)) { setMessage(t('unsavedLabel')); return }; setEditing({ dimension, label }); setName(label.name); setColor(label.color ?? ''); setGroupId(((label as { groupId?: string | null }).groupId ?? '') || '') }}>{t('edit')}</button><button disabled={busy} title={t('deleteUnused')} onClick={() => setDeleting({ dimension, label })}>{t('delete')}</button></>}</div></div>
    })}</div>
    {deleting?.dimension === dimension && <div className="sd-draftbar"><p>{t('deleteTagQuestion', { name: deleting.label.name })}</p><button onClick={() => setDeleting(null)}>{t('cancel')}</button><button disabled={busy} onClick={() => { if (!validService()) return; void client.mutate({ type: 'delete_label', dimension, id: deleting.label.id, expectedRevision: deleting.label.revision }).then(result => { if (result) setDeleting(null) }) }}>{t('confirmDelete')}</button></div>}
    <form className="sd-stack" onSubmit={event => { event.preventDefault(); void save(dimension) }}>
      <h4>{t(editing?.dimension === dimension ? 'editDimension' : 'createDimension', { dimension: t(dimension) })}</h4>
      <label className="sd-formfield"><span>{t('name')}</span><input aria-label={t('dimensionName', { dimension: t(dimension) })} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)}/></label>
      {dimension === 'tag' && <label className="sd-formfield"><span>{t('groupLabel')}</span><select aria-label={t('groupLabel')} value={groupId} disabled={busy} onChange={event => setGroupId(event.target.value)}><option value="">{t('groupNone')}</option>{board.tagGroups.filter(group => !group.builtin || editing?.label == null).map(group => <option key={group.id} value={group.id}>{group.name}{group.builtin ? ` · ${t('builtinGroup')}` : ''}</option>)}</select></label>}
      <ColorField label={t('labelColor')} hint={t('optionalColor')} value={color} disabled={busy} onChange={setColor}/>
      <div className="sd-row"><button type="submit" className="sd-primary" disabled={busy || !name.trim()}>{t(editing?.dimension === dimension ? 'saveLabel' : 'createLabel')}</button><button type="button" onClick={reset}>{t('discardEdit')}</button></div>
      {dimension === 'tag' && <p className="sd-small">{t('tagManagementHint')}</p>}
    </form>
  </Collapsible>

  const orderedGroups = (() => {
    const byId = new Map(board.tagGroups.map(group => [group.id, group] as const))
    const ordered = board.orders.tagGroup.ids.flatMap(id => { const group = byId.get(id); return group ? [group] : [] })
    return [...ordered, ...board.tagGroups.filter(group => !board.orders.tagGroup.ids.includes(group.id))]
  })()
  const reorderGroup = async (id: string, offset: number) => {
    if (!validService()) return
    const ids = [...board.orders.tagGroup.ids].filter(value => board.tagGroups.some(group => group.id === value))
    const index = ids.indexOf(id), target = index + offset
    if (index < 0 || target < 0 || target >= ids.length) return
    ids.splice(index, 1); ids.splice(target, 0, id)
    const result = await client.mutate({ type: 'reorder', dimension: 'tagGroup', ids, expectedRevision: board.orders.tagGroup.revision })
    setMessage(result ? t('orderSaved') : client.getSnapshot().error)
  }

  const tagGroupSection = <Collapsible title={t('tagGroups')} summary={t('tagGroupSummary', { count: board.tagGroups.length })} open={sectionOpen('groups')} onToggle={() => toggleSection('groups')}>
    <p className="sd-small sd-muted">{t('tagGroupsHint')}</p>
    {board.tagGroups.length === 0 && <p className="sd-small sd-muted">{t('noTagGroups')}</p>}
    <div className="sd-stack" role="list">{orderedGroups.map((group, index, groups) => <div className="sd-orderrow" key={group.id} role="listitem"><span>{group.name}{group.builtin && <span className="sd-small sd-muted"> · {t('builtinGroup')}</span>}<span className="sd-small sd-muted"> ({group.id === PROJECT_GROUP_ID ? board.projects.length : board.tags.filter(tag => (tag as { groupId?: string | null }).groupId === group.id).length})</span></span><div className="sd-row"><button className="sd-small" aria-label={t('movePrevious', { name: group.name })} disabled={busy || index === 0} onClick={() => { void reorderGroup(group.id, -1) }}>↑</button><button className="sd-small" aria-label={t('moveNext', { name: group.name })} disabled={busy || index === groups.length - 1} onClick={() => { void reorderGroup(group.id, 1) }}>↓</button>{!group.builtin && <><button disabled={busy} onClick={() => { if (groupDirty) { setMessage(t('unsavedLabel')); return }; setEditingGroup(group); setGroupName(group.name); setGroupColor(group.color ?? '') }}>{t('edit')}</button><button disabled={busy || board.tags.some(tag => (tag as { groupId?: string | null }).groupId === group.id)} title={t(board.tags.some(tag => (tag as { groupId?: string | null }).groupId === group.id) ? 'deleteReferenced' : 'deleteUnused')} onClick={() => setDeletingGroup(group)}>{t('delete')}</button></>}</div></div>)}</div>
    <form className="sd-stack" onSubmit={event => { event.preventDefault(); void saveGroup() }}><h4>{t(editingGroup ? 'editTagGroup' : 'createTagGroup')}</h4><label className="sd-formfield"><span>{t('name')}</span><input aria-label={t('tagGroupName')} value={groupName} maxLength={80} disabled={busy} onChange={event => setGroupName(event.target.value)}/></label><ColorField label={t('labelColor')} hint={t('optionalColor')} value={groupColor} disabled={busy} onChange={setGroupColor}/><div className="sd-row"><button type="submit" className="sd-primary" disabled={busy || !groupName.trim()}>{t(editingGroup ? 'saveLabel' : 'createTagGroup')}</button><button type="button" onClick={resetGroup}>{t('discardEdit')}</button></div></form>
    {deletingGroup && <div className="sd-draftbar"><p>{t('deleteTagGroupQuestion', { name: deletingGroup.name })}</p><button onClick={() => setDeletingGroup(null)}>{t('cancel')}</button><button disabled={busy} onClick={() => { if (!validService()) return; void client.mutate({ type: 'delete_tag_group', groupId: deletingGroup.id, expectedRevision: deletingGroup.revision }).then(result => { if (result) setDeletingGroup(null) }) }}>{t('confirmDelete')}</button></div>}
  </Collapsible>

  return <Modal title={t('manageTitle')} busy={busy} onClose={() => anyEdit ? setClosing(true) : onClose()}>
    <p className="sd-small sd-muted">{t('manageHint')}</p>
    <div className="sd-segment" role="group" aria-label={t('orderDimension')}>{(['categories', 'tag'] as const).map(value => <button key={value} aria-pressed={segment === value} disabled={busy} onClick={() => { if (anyEdit) { setMessage(t('unsavedEdit')); return }; reset(); resetGroup(); setSegment(value) }}>{t(value === 'categories' ? 'categoriesSegment' : 'tag')}</button>)}</div>
    {message && <p role="status" className="sd-small">{message}</p>}
    {closing && <div className="sd-draftbar sd-stack"><p>{t('leaveLabel')}</p><div className="sd-row"><button onClick={() => setClosing(false)}>{t('continueEditing')}</button><button onClick={onClose}>{t('discardClose')}</button><button disabled={busy} onClick={onClose}>{t('saveClose')}</button></div></div>}
    {segment === 'categories' ? statusSection : <>{projectSection}<hr className="sd-divider"/>{tagGroupSection}<hr className="sd-divider"/>{labelSection('tag')}</>}
  </Modal>
}
