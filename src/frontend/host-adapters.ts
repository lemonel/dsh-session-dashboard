import type { Context } from '@deepseek-ai/cordis'

type Scope = { get(key: string): unknown }
type Picker = { pick(signal?: AbortSignal): Promise<{ ok: true; value: string | null } | { ok: false; error: { message: string } }> }
type PresetList = { list(): Promise<{ ok: true; value: { presets: readonly { id: string; name?: string; description?: string; isDefault: boolean; broken?: string }[] } } | { ok: false; error: { message: string } }> }
type ModelCatalog = { modelCatalog(): Promise<{ ok: true; value: { default: { provider: string; model: string; reasoningEffort?: string }; groups: readonly { id: string; name: string; models: readonly { id: string; name: string; description?: string; reasoning?: { defaultEffort?: string } }[] }[]; failures: readonly { id: string; name: string; message: string }[] } } | { ok: false; error: { message: string } }> }
export interface SessionRemote {
  create(request: { workspaceId: string; agentPreset?: string }): Promise<{ ok: true; value: { sessionId: string } } | { ok: false; error: { message: string } }>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ ok: true } | { ok: false; error: { message: string } }>
}

/** Optional Remote namespaces are read from the scoped child first and the root
 *  context second; a missing Host composition lowers only that selector instead of
 *  aborting the plugin apply. */
export function createHostAdapters(context: Context, child: Scope) {
  const remoteService = (key: string): unknown => {
    try { const value = child.get(key); if (value !== undefined) return value } catch { /* try the root */ }
    try { return context.get(key) } catch { return undefined }
  }
  // The directory picker is optional (native, browse, or absent). Resolve it lazily:
  // reading an optional Remote namespace eagerly can reject on a Host that does not
  // compose it, which would remove the native-sidebar entry. The picker dialog keeps
  // the manual absolute-path field as its fallback.
  const pickDirectory = async (): Promise<string | null> => {
    const picker = remoteService('remote.directoryPicker') as Picker | undefined
    if (!picker) throw new Error('Directory picker unavailable')
    const result = await picker.pick()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  // Presets and models are optional Host namespaces too: resolve them lazily so a
  // missing composition lowers the selector to unavailable, never the plugin.
  const listPresets = async () => {
    const presets = remoteService('remote.agentPresets') as PresetList | undefined
    if (!presets) return []
    const result = await presets.list()
    if (!result.ok) throw new Error(result.error.message)
    return result.value.presets.map(item => ({ id: item.id, name: item.name?.trim() || item.id, description: item.description, isDefault: item.isDefault, broken: item.broken }))
  }
  const loadModels = async () => {
    const session = remoteService('remote.session') as ModelCatalog | undefined
    if (!session) return { default: null, groups: [], failures: [] }
    const result = await session.modelCatalog()
    if (!result.ok) throw new Error(result.error.message)
    const groups = result.value.groups.map(group => ({ id: group.id, name: group.name, models: group.models.map(model => ({
      provider: group.id, providerName: group.name, model: model.id, name: model.name, description: model.description, reasoningEffort: model.reasoning?.defaultEffort,
    })) }))
    const choices = groups.flatMap(group => group.models)
    const preferred = result.value.default
    const selected = choices.find(choice => choice.provider === preferred.provider && choice.model === preferred.model && (choice.reasoningEffort ?? '') === (preferred.reasoningEffort ?? ''))
      ?? choices.find(choice => choice.provider === preferred.provider && choice.model === preferred.model) ?? null
    return { default: selected, groups, failures: result.value.failures.map(failure => ({ name: failure.name, message: failure.message })) }
  }
  const sessionRemote = (): SessionRemote | undefined => remoteService('remote.session') as SessionRemote | undefined
  return { remoteService, pickDirectory, listPresets, loadModels, sessionRemote }
}
