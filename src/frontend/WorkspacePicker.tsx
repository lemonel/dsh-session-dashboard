import { useEffect, useId, useRef, useState } from 'react'
import { Modal } from './Modal.js'
import { useTranslator } from './i18n.js'

/** One selectable Workspace, identified by the Host's stable id. */
export interface WorkspaceChoice { readonly workspaceId: string; readonly title: string; readonly path: string }
/** One Agent preset the Host offers for a new Session. */
export interface SessionPresetChoice { readonly id: string; readonly name: string; readonly description?: string; readonly isDefault?: boolean; readonly broken?: string }
/** One provider/model route; reasoning effort defaults to the route's default. */
export interface SessionModelChoice { readonly provider: string; readonly providerName: string; readonly model: string; readonly name: string; readonly description?: string; readonly reasoningEffort?: string }
export interface SessionModelGroup { readonly id: string; readonly name: string; readonly models: readonly SessionModelChoice[] }
export interface SessionModelCatalog { readonly default: SessionModelChoice | null; readonly groups: readonly SessionModelGroup[]; readonly failures: readonly { readonly name: string; readonly message: string }[] }
export interface SessionModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
export interface SessionCreateOptions { readonly agentPreset?: string; readonly model?: SessionModelSelection }

/** A Workspace without a title falls back to its last path segment. */
export function workspaceTitle(choice: WorkspaceChoice): string {
  const title = choice.title.trim()
  if (title) return title
  const segment = choice.path.split(/[\\/]/).filter(Boolean).at(-1)
  return segment || choice.path
}
const modelKey = (model: SessionModelSelection): string => [model.provider, model.model, model.reasoningEffort ?? ''].join('\u0000')

/** The dashboard's New Session dialog. It mirrors the Host's own creation surface:
 *  Workspace first, then Agent mode and model, then an optional first message. */
export function WorkspacePickerDialog({ initialWorkspaceId = null, list, listPresets, loadModels, busy = false, promptEnabled = false, onPickDirectory, onCreateWorkspace, onChoose, onClose }: {
  initialWorkspaceId?: string | null
  list: () => Promise<readonly WorkspaceChoice[]>
  listPresets?: () => Promise<readonly SessionPresetChoice[]>
  loadModels?: () => Promise<SessionModelCatalog>
  busy?: boolean
  promptEnabled?: boolean
  /** Host OS directory chooser; null means the operator cancelled. */
  onPickDirectory?: () => Promise<string | null>
  /** Register the chosen absolute directory and return its Workspace projection. */
  onCreateWorkspace?: (path: string) => Promise<WorkspaceChoice>
  onChoose: (workspaceId: string, prompt: string, options: SessionCreateOptions) => void
  onClose: () => void
}) {
  const t = useTranslator(), promptId = useId(), pathId = useId(), presetId = useId(), modelId = useId()
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceChoice[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [createFailure, setCreateFailure] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [presets, setPresets] = useState<readonly SessionPresetChoice[] | null>(null)
  const [preset, setPreset] = useState<string>('')
  const [presetFailure, setPresetFailure] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<SessionModelCatalog | null>(null)
  const [model, setModel] = useState<string>('')
  const [modelFailure, setModelFailure] = useState<string | null>(null)
  const mounted = useRef(true), request = useRef(0), group = useRef<HTMLDivElement>(null), promptInput = useRef<HTMLTextAreaElement>(null)
  const load = async () => {
    const ticket = ++request.current
    setLoading(true); setFailure(null)
    try {
      const items = await list()
      if (!mounted.current || ticket !== request.current) return
      setWorkspaces(items)
      const remembered = initialWorkspaceId !== null && items.some(item => item.workspaceId === initialWorkspaceId) ? initialWorkspaceId : items[0]?.workspaceId ?? null
      setSelected(remembered)
    } catch (error) {
      if (!mounted.current || ticket !== request.current) return
      setWorkspaces(null)
      setFailure(error instanceof Error ? error.message : String(error))
    } finally { if (mounted.current && ticket === request.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; void load()
    if (listPresets) listPresets().then(items => {
      if (!mounted.current) return
      setPresets(items)
      const preferred = items.find(item => item.isDefault && item.broken === undefined) ?? items.find(item => item.broken === undefined)
      if (preferred) setPreset(preferred.id)
    }).catch(error => { if (mounted.current) setPresetFailure(error instanceof Error ? error.message : String(error)) })
    if (loadModels) loadModels().then(value => {
      if (!mounted.current) return
      setCatalog(value)
      if (value.default) setModel(modelKey(value.default))
      else { const first = value.groups.find(group => group.models.length > 0)?.models[0]; if (first) setModel(modelKey(first)) }
    }).catch(error => { if (mounted.current) setModelFailure(error instanceof Error ? error.message : String(error)) })
    return () => { mounted.current = false; request.current++ }
  }, [])
  const addWorkspace = async (resolve: () => Promise<string | null>) => {
    if (creatingWorkspace || busy || !onCreateWorkspace) return
    setCreatingWorkspace(true); setCreateFailure(null)
    try {
      const path = await resolve()
      if (path === null || path.trim() === '') return
      const created = await onCreateWorkspace(path.trim())
      if (!mounted.current) return
      setWorkspaces(current => [created, ...(current ?? []).filter(item => item.workspaceId !== created.workspaceId)])
      setSelected(created.workspaceId)
    } catch (error) {
      if (mounted.current) setCreateFailure(error instanceof Error ? error.message : String(error))
    } finally { if (mounted.current) setCreatingWorkspace(false) }
  }
  const focusAt = (index: number) => {
    const options = group.current?.querySelectorAll<HTMLInputElement>('input[type=radio]')
    options?.[index]?.focus()
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy || !workspaces?.length) return
    const values = workspaces
    const index = Math.max(0, values.findIndex(item => item.workspaceId === selected))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? Math.min(values.length - 1, index + 1) : Math.max(0, index - 1)
      setSelected(values[next].workspaceId); focusAt(next)
    } else if (event.key === 'Enter') {
      // Enter only moves into the optional message; it never creates a Session,
      // so the first message cannot be skipped by accident.
      event.preventDefault()
      if (promptEnabled) promptInput.current?.focus()
    }
  }
  const availablePresets = presets ?? []
  const modelGroups = catalog?.groups ?? []
  const models = modelGroups.flatMap(group => group.models)
  const selectedModel = models.find(item => modelKey(item) === model) ?? null
  const selectedPreset = presets?.find(item => item.id === preset) ?? null
  return <Modal wide title={t('newSessionTitle')} onClose={onClose} busy={busy}>
    <div className="sd-new-session sd-stack">
      <p className="sd-small sd-muted">{t('newSessionHint')}</p>
      <section className="sd-new-session-section" aria-label={t('newSessionWorkspace')}>
        <div className="sd-new-session-head"><h3>{t('newSessionWorkspace')}</h3><span className="sd-small sd-muted">{t('newSessionWorkspaceHint')}</span></div>
        {loading && <p role="status">{t('workspaceLoading')}</p>}
        {failure && <div role="alert" className="sd-draftbar sd-error"><p>{t('workspaceFailed', { reason: failure })}</p><button type="button" disabled={loading || busy} onClick={() => { void load() }}>{t('workspaceRetry')}</button></div>}
        {!loading && !failure && workspaces?.length === 0 && <p>{t('workspaceEmpty')}</p>}
        {!failure && workspaces && workspaces.length > 0 && <div className="sd-workspace-list" role="radiogroup" aria-label={t('workspaceTitle')} tabIndex={0} data-autofocus onKeyDown={onKeyDown} ref={group}>
          {workspaces.map(item => <label key={item.workspaceId} className="sd-workspace-option" data-selected={selected === item.workspaceId ? 'true' : undefined}>
            <input type="radio" name="sd-workspace" value={item.workspaceId} checked={selected === item.workspaceId} disabled={busy} aria-label={workspaceTitle(item)} onChange={() => setSelected(item.workspaceId)}/>
            <span><strong>{workspaceTitle(item)}</strong><span className="sd-small sd-muted">{item.path}</span></span>
            {selected === item.workspaceId && <span className="sd-workspace-check" aria-hidden="true">✓</span>}
          </label>)}
        </div>}
        {onCreateWorkspace && <div className="sd-workspace-create">
          <div className="sd-new-session-head"><h4>{t('workspaceCreateTitle')}</h4><span className="sd-small sd-muted">{t('workspaceCreateHint')}</span></div>
          <div className="sd-row">
            {onPickDirectory && <button type="button" disabled={busy || creatingWorkspace || loading} onClick={() => { void addWorkspace(onPickDirectory) }}>{t('workspacePickFolder')}</button>}
            <label className="sd-formfield sd-workspace-path" htmlFor={pathId}><span>{t('workspacePathLabel')}</span><input id={pathId} value={manualPath} disabled={busy || creatingWorkspace} placeholder={t('workspacePathPlaceholder')} onChange={event => setManualPath(event.target.value)}/></label>
            <button type="button" disabled={busy || creatingWorkspace || manualPath.trim() === ''} onClick={() => { void addWorkspace(async () => manualPath) }}>{t('workspacePathCreate')}</button>
          </div>
          {createFailure && <p role="alert" className="sd-error">{t('workspaceCreateFailed', { reason: createFailure })}</p>}
        </div>}
      </section>
      {(listPresets || loadModels) && <section className="sd-new-session-options" aria-label={t('newSessionOptions')}>
        {listPresets && <label className="sd-formfield" htmlFor={presetId}><span>{t('newSessionPreset')}</span>
          {presets === null && presetFailure === null ? <p className="sd-small sd-muted">{t('newSessionPresetLoading')}</p>
            : presetFailure !== null ? <p role="alert" className="sd-small sd-error">{t('newSessionPresetFailed', { reason: presetFailure })}</p>
              : <select id={presetId} value={preset} disabled={busy} onChange={event => setPreset(event.target.value)}>
                {availablePresets.length === 0 && <option value="">{t('newSessionPresetEmpty')}</option>}
                {availablePresets.map(item => <option key={item.id} value={item.id} disabled={item.broken !== undefined}>{item.name}{item.broken === undefined ? '' : ` · ${t('newSessionPresetBroken')}`}</option>)}
              </select>}
          {selectedPreset?.description && <small>{selectedPreset.description}</small>}
        </label>}
        {loadModels && <label className="sd-formfield" htmlFor={modelId}><span>{t('newSessionModel')}</span>
          {catalog === null && modelFailure === null ? <p className="sd-small sd-muted">{t('newSessionModelLoading')}</p>
            : modelFailure !== null ? <p role="alert" className="sd-small sd-error">{t('newSessionModelFailed', { reason: modelFailure })}</p>
              : <select id={modelId} value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
                {models.length === 0 && <option value="">{t('newSessionModelEmpty')}</option>}
                {modelGroups.filter(group => group.models.length > 0).map(group => <optgroup key={group.id} label={group.name}>
                  {group.models.map(item => <option key={modelKey(item)} value={modelKey(item)}>{item.name}</option>)}
                </optgroup>)}
              </select>}
          {selectedModel?.description && <small>{selectedModel.description}</small>}
          {catalog?.failures.map(failure => <small key={failure.name} className="sd-error">{failure.name}: {failure.message}</small>)}
        </label>}
      </section>}
      {promptEnabled && <div className="sd-stack">
        <label className="sd-formfield" htmlFor={promptId}><span>{t('workspacePromptLabel')}</span>
          <textarea id={promptId} ref={promptInput} aria-label={t('workspacePromptLabel')} placeholder={t('workspacePromptPlaceholder')} maxLength={20000} rows={4} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)}/>
        </label>
        <p className="sd-small sd-muted">{t('workspacePromptCount', { count: prompt.length })}</p>
      </div>}
    </div>
    <div className="sd-modal-foot">
      <button type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
      <button type="button" className="sd-primary" disabled={!selected || loading || Boolean(failure) || busy} onClick={() => {
        if (selected) onChoose(selected, prompt.trim(), { agentPreset: preset || undefined, model: selectedModel === null ? undefined : { provider: selectedModel.provider, model: selectedModel.model, ...(selectedModel.reasoningEffort === undefined ? {} : { reasoningEffort: selectedModel.reasoningEffort }) } })
      }}>{t('workspaceUse')}</button>
    </div>
  </Modal>
}
