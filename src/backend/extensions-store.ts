import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { FEATURES, isFeature } from '../shared/extensions/contract.js'

/** One extension as the management surface and the loader see it. The manifest is
 *  authoritative here: a module cannot grant itself capabilities by exporting a
 *  different one. */
export interface ExtensionEntry {
  id: string
  name: string
  version: string | null
  description: string | null
  requires: readonly string[]
  optional: readonly string[]
  enabled: boolean
  /** False when the manifest or the module file is unusable; `problem` says why. */
  ok: boolean
  problem: string | null
}

/** Filesystem identity rules shared with the browser contract. */
const IDENTITY = /^[a-z0-9][a-z0-9._-]*$/i
const MANIFEST = 'extension.json'
const MODULE = 'index.js'
const STATE = 'registry.json'
const STATE_VERSION = 1

interface StateFile { version: number; disabled: string[] }

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
  return [...new Set(value as string[])]
}

/** Read and validate one `extension.json`. Returns a reason instead of throwing so
 *  a single malformed directory stays visible in the list. */
export function readManifest(raw: unknown): { manifest: Omit<ExtensionEntry, 'enabled' | 'ok' | 'problem'>; problem: null } | { manifest: null; problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { manifest: null, problem: `${MANIFEST} must be an object` }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!IDENTITY.test(id)) return { manifest: null, problem: 'id must be letters, digits, dot, dash or underscore' }
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : id
  const requires = stringList(record.requires)
  if (requires === null) return { manifest: null, problem: 'requires must be an array of capability ids' }
  const optional = stringList(record.optional)
  if (optional === null) return { manifest: null, problem: 'optional must be an array of capability ids' }
  const unknown = [...requires, ...optional].filter(feature => !isFeature(feature))
  if (unknown.length > 0) return { manifest: null, problem: `unknown capability: ${unknown.join(', ')} (known: ${FEATURES.join(', ')})` }
  return {
    manifest: {
      id,
      name,
      version: typeof record.version === 'string' && record.version.trim() !== '' ? record.version.trim() : null,
      description: typeof record.description === 'string' && record.description.trim() !== '' ? record.description.trim() : null,
      requires,
      optional,
    },
    problem: null,
  }
}

/** The extension directory: one folder per extension, a manifest, an ES module and
 *  one small state file that only records what the user turned off. */
export class ExtensionRegistry {
  readonly root: string
  private readonly statePath: string
  private queue: Promise<unknown> = Promise.resolve()

  /** `builtinIds` are the extensions compiled into this build: they have no
   *  directory of their own, but the same state file records them as switched
   *  off, so one list governs both kinds. */
  constructor(dataDirectory: string, builtinIds: readonly string[] = []) {
    this.root = join(dataDirectory, 'extensions')
    this.statePath = join(this.root, STATE)
    this.builtinIds = new Set(builtinIds)
  }

  private readonly builtinIds: ReadonlySet<string>

  private async state(): Promise<StateFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return { version: STATE_VERSION, disabled: [] }
      const disabled = stringList((parsed as { disabled?: unknown }).disabled)
      return { version: STATE_VERSION, disabled: disabled ?? [] }
    } catch {
      // A missing or unreadable state file means "nothing turned off": the files
      // the operator dropped in are enabled by default.
      return { version: STATE_VERSION, disabled: [] }
    }
  }

  private async writeState(state: StateFile): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Real path of one extension file, or null when the id escapes the directory. */
  private async safe(id: string, file: string): Promise<string | null> {
    if (!IDENTITY.test(id)) return null
    const candidate = resolve(this.root, id, file)
    try {
      const real = await realpath(candidate)
      const base = await realpath(this.root)
      const scope = relative(base, real)
      if (scope === '' || scope.startsWith('..') || scope.includes(`..${sep}`)) return null
      return real
    } catch {
      return null
    }
  }

  /** Every directory that declares a manifest, plus why it is unusable. */
  async list(): Promise<ExtensionEntry[]> {
    const state = await this.state()
    let names: string[]
    try {
      names = (await readdir(this.root, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name)
    } catch {
      return []
    }
    const entries: ExtensionEntry[] = []
    for (const directory of names.sort()) {
      const manifestPath = await this.safe(directory, MANIFEST)
      if (manifestPath === null) {
        entries.push({ id: directory, name: directory, version: null, description: null, requires: [], optional: [], enabled: !state.disabled.includes(directory), ok: false, problem: `${MANIFEST} is missing or unreadable` })
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch (error) {
        entries.push({ id: directory, name: directory, version: null, description: null, requires: [], optional: [], enabled: !state.disabled.includes(directory), ok: false, problem: `cannot read ${MANIFEST}: ${problemOf(error)}` })
        continue
      }
      const parsed = readManifest(raw)
      if (parsed.manifest === null) {
        entries.push({ id: directory, name: directory, version: null, description: null, requires: [], optional: [], enabled: !state.disabled.includes(directory), ok: false, problem: parsed.problem })
        continue
      }
      const manifest = parsed.manifest
      const modulePath = await this.safe(manifest.id, MODULE)
      const moduleOk = modulePath !== null && (await stat(modulePath).then(item => item.isFile(), () => false))
      entries.push({
        ...manifest,
        enabled: !state.disabled.includes(manifest.id),
        ok: moduleOk,
        problem: moduleOk ? null : `${MODULE} is missing or unreadable`,
      })
    }
    return entries
  }

  /** Turn one extension on or off. Unknown ids are refused rather than invented;
   *  a built-in id is known without having a directory. */
  async setEnabled(id: string, enabled: boolean): Promise<readonly ExtensionEntry[]> {
    const entries = await this.list()
    if (!entries.some(entry => entry.id === id) && !this.builtinIds.has(id)) throw new Error(`unknown extension: ${id}`)
    this.queue = this.queue.then(async () => {
      const state = await this.state()
      const disabled = new Set(state.disabled)
      if (enabled) disabled.delete(id)
      else disabled.add(id)
      await this.writeState({ version: STATE_VERSION, disabled: [...disabled].sort() })
    })
    await this.queue
    return this.list()
  }

  /** Every id currently switched off, built-ins included: the browser needs this
   *  to decide which bundled extensions it may mount. */
  async disabled(): Promise<string[]> {
    return [...(await this.state()).disabled]
  }

  /** Module source for one enabled extension, or a reason it cannot be served. */
  async readModule(id: string): Promise<{ source: string } | { problem: string }> {
    const entries = await this.list()
    const entry = entries.find(candidate => candidate.id === id)
    if (entry === undefined) return { problem: `unknown extension: ${id}` }
    if (!entry.enabled) return { problem: `extension is disabled: ${id}` }
    if (!entry.ok) return { problem: entry.problem ?? 'extension is unusable' }
    const path = await this.safe(id, MODULE)
    if (path === null) return { problem: `module path escapes the extension directory: ${id}` }
    try {
      return { source: await readFile(path, 'utf8') }
    } catch (error) {
      return { problem: `cannot read ${MODULE}: ${problemOf(error)}` }
    }
  }

  /** Absolute directory that holds every extension (for diagnostics). */
  get directory(): string { return this.root }
}
