#!/usr/bin/env node
// Static/public API evidence, not a substitute for the matrix's behavioral suite.
// --host-root is the ONLY SDK source (a project or its node_modules directory).
import { readdir, readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const isDshPackage = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
const problem = (code, message) => Object.assign(new Error(message), { code })

/** An exact, finite engines.dsh union is the authoritative advertised matrix. */
export function readSupportedVersions(manifest) {
  if (typeof manifest.engines?.dsh !== 'string') throw problem('INVALID_SUPPORT_LIST', 'package engines.dsh must declare an exact version union')
  const values = manifest.engines.dsh.split('||').map(value => value.trim())
  if (!values.length || values.some(value => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(value))) {
    throw problem('INVALID_SUPPORT_LIST', 'engines.dsh must list exact versions, not an open-ended range')
  }
  if (new Set(values).size !== values.length) throw problem('INVALID_SUPPORT_LIST', 'engines.dsh contains duplicate versions')
  return values
}

export async function localNodeModules(root) {
  const absolute = resolve(root)
  const path = absolute.endsWith(`${sep}node_modules`) ? absolute : join(absolute, 'node_modules')
  try { return await realpath(path) } catch { throw problem('MISSING_DEPENDENCY', `SDK node_modules does not exist at ${path}; no global fallback is allowed`) }
}

/** Require a direct local package before resolving any export; never load a fallback. */
export async function localPackage(nodeModules, name) {
  const target = join(nodeModules, ...name.split('/'))
  let directory, manifest
  try {
    directory = await realpath(target)
    if (!inside(await realpath(nodeModules), directory)) throw problem('OUTSIDE_HOST_ROOT', `${name} resolves outside the selected SDK tree: ${directory}`)
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'OUTSIDE_HOST_ROOT') throw error
    throw problem('MISSING_DEPENDENCY', `${name} is required at ${target}: ${error.message}`)
  }
  if (manifest.name !== name) throw problem('PACKAGE_IDENTITY_MISMATCH', `${target} declares ${manifest.name}, not ${name}`)
  return { name, version: manifest.version, directory, manifest }
}

/** All nested DSH packages count, not only whichever copy happened to resolve first. */
export async function inspectInstalledTree(nodeModules, expectedVersion) {
  // Containment must compare canonical paths: macOS turns /var into /private/var and
  // a Windows 8.3 prefix (RUNNER~1) never equals the realpath of its children.
  const root = await realpath(nodeModules).catch(error => { throw problem('MISSING_DEPENDENCY', `SDK node_modules does not exist at ${nodeModules}: ${error.message}`) })
  const packages = []
  const seen = new Set()
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) { await visit(join(directory, entry.name)); continue }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = await realpath(join(directory, entry.name))
      if (!inside(root, path)) throw problem('OUTSIDE_HOST_ROOT', `An installed package escapes the SDK root: ${path}`)
      if (seen.has(path)) continue
      seen.add(path)
      let manifest
      try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (isDshPackage(manifest.name ?? '')) {
        packages.push({ name: manifest.name, version: manifest.version, path })
        if (manifest.version !== expectedVersion) throw problem('MIXED_DSH_VERSIONS', `${manifest.name}@${manifest.version} at ${path}, expected exactly ${expectedVersion}`)
      }
      try { await stat(join(path, 'node_modules')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      await visit(join(path, 'node_modules'))
    }
  }
  await visit(root)
  if (!packages.length) throw problem('MISSING_DEPENDENCY', `No DSH packages found in ${nodeModules}`)
  return packages
}

async function resolveExport(nodeModules, specifier) {
  const name = specifier.split('/').slice(0, 2).join('/')
  const owner = await localPackage(nodeModules, name)
  const require = createRequire(join(nodeModules, '__dashboard_surface_probe__.cjs'))
  let resolved
  try { resolved = await realpath(require.resolve(specifier)) }
  catch (error) { throw problem('MISSING_EXPORT', `${specifier} cannot resolve in the selected SDK: ${error.message}`) }
  if (!inside(owner.directory, resolved)) throw problem('OUTSIDE_HOST_ROOT', `${specifier} resolves outside its local package: ${resolved}`)
  return resolved
}

async function sourceImports(sourceRoot, nodeModules) {
  // Use the selected project's compiler, never a global TypeScript installation.
  const compiler = await localPackage(nodeModules, 'typescript')
  const ts = (await import(pathToFileURL(join(compiler.directory, 'lib/typescript.js')).href)).default
  const imports = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await visit(path); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      const text = await readFile(path, 'utf8')
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      const add = (specifier, exports, mode) => { if (specifier.startsWith('@deepseek-ai/')) imports.push({ source: relative(sourceRoot, path), specifier, exports, mode }) }
      function walk(node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text
          const clause = node.importClause
          if (!clause) add(specifier, [], 'runtime')
          else if (!clause.isTypeOnly) {
            const names = []
            if (clause.name) names.push('default')
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) names.push((binding.propertyName ?? binding.name).text)
            }
            add(specifier, names, clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? 'namespace' : 'runtime')
          } else add(specifier, [], 'types')
        }
        if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
          const expression = node.expression.getText(source)
          if (expression === 'import' || expression === 'import.meta.resolve') add(node.arguments[0].text, [], expression === 'import' ? 'runtime' : 'resolve')
        }
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
  }
  await visit(join(sourceRoot, 'src'))
  if (!imports.length) throw problem('NO_SOURCE_IMPORTS', 'No host imports were found in the maintained TypeScript source')
  return imports
}

const REQUIRED = {
  'dsh-session': { Session: ['append'], SessionStore: ['get', 'list', 'flush'], SessionId: [], SessionLogOffset: [] },
  'dsh-agent': { AgentRegistry: ['get', 'list', 'roots', 'create', 'resume'] },
  'dsh-session-query': { SessionQueryEngine: ['observeSession', 'listSessions', 'readTitle'] },
  'dsh-session-projection': { SessionProjectionRegistry: ['snapshot', 'restore'] },
  'dsh-session-persistence': { SessionPersistence: [], SessionPersistenceNotFoundError: [] },
  'dsh-goal': { GoalService: ['get'], applyGoalProjection: [], goalProjectionDefinition: [] },
  'dsh-user-questions': { UserQuestionService: ['ask'] },
  'dsh-user-approval': { ApprovalService: ['request'] },
  'dsh-typert-protocol': { Remote: [], RemoteError: [], TypertRemoteService: [] },
  'dsh-typert-registry': { default: ['register'] },
  'dsh-api-gateway': { default: ['invoke'] },
  'dsh-agent-loop-testkit': { mountAgentLoopTestDependencies: [], mountAgentLoopTestHarness: [] },
  'dsh-system-prompt': { SystemPrompt: ['assemble'] },
  'dsh-client-ui-slots': { SlotCore: ['register'] },
}

/** JSON result deliberately distinguishes surface evidence from behavioral results. */
export async function checkHostSurface({ hostRoot = pluginRoot, sourceRoot = pluginRoot, version } = {}) {
  const result = { schemaVersion: 1, kind: 'host-surface', ok: false, hostRoot: resolve(hostRoot), sourceRoot: resolve(sourceRoot), version: version ?? null,
    supportedVersions: [], packages: [], imports: [], checks: [], capabilities: {}, errors: [] }
  const record = error => result.errors.push({ code: error.code ?? 'SURFACE_FAILURE', message: error.message })
  try {
    const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
    result.supportedVersions = readSupportedVersions(manifest)
    if (version && !result.supportedVersions.includes(version)) throw problem('UNSUPPORTED_VERSION', `DSH ${version} is not in the exact advertised support list`)
    const nodeModules = await localNodeModules(hostRoot)
    result.nodeModules = nodeModules
    const agent = await localPackage(nodeModules, '@deepseek-ai/dsh-agent')
    result.version = version ?? agent.version
    if (!result.supportedVersions.includes(result.version)) throw problem('UNSUPPORTED_VERSION', `Installed DSH ${result.version} is not declared supported`)
    result.packages = await inspectInstalledTree(nodeModules, result.version)
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/')).sort()) {
      try {
        const pkg = await localPackage(nodeModules, name)
        if (isDshPackage(name) && pkg.version !== result.version) throw problem('MIXED_DSH_VERSIONS', `${name}@${pkg.version}, expected ${result.version}`)
        result.checks.push({ kind: 'package', name, passed: true, evidence: join(pkg.directory, 'package.json') })
      } catch (error) { record(error) }
    }
    if (result.errors.length) return result
    const loaded = new Map()
    async function load(specifier) {
      if (!loaded.has(specifier)) loaded.set(specifier, await import(pathToFileURL(await resolveExport(nodeModules, specifier)).href))
      return loaded.get(specifier)
    }
    for (const entry of await sourceImports(sourceRoot, nodeModules)) {
      try {
        const resolved = await resolveExport(nodeModules, entry.specifier)
        // Native browser factories execute only in the separate Chrome stage.
        if ((entry.mode === 'runtime' || entry.mode === 'namespace') && !entry.specifier.endsWith('/client')) {
          const available = await load(entry.specifier)
          for (const name of entry.exports) if (!(name in available)) throw problem('MISSING_SYMBOL', `${entry.source} imports missing ${entry.specifier}.${name}`)
        }
        result.imports.push({ ...entry, resolved, passed: true })
      } catch (error) { record(error); result.imports.push({ ...entry, passed: false }) }
    }
    for (const [name, symbols] of Object.entries(REQUIRED)) {
      try {
        const specifier = `@deepseek-ai/${name}`
        const exports = await load(specifier)
        for (const [symbol, methods] of Object.entries(symbols)) {
          if (!(symbol in exports)) throw problem('MISSING_SYMBOL', `${specifier} does not export ${symbol}`)
          for (const method of methods) if (typeof exports[symbol]?.prototype?.[method] !== 'function') throw problem('MISSING_METHOD', `${specifier}.${symbol}.prototype.${method} is required`)
        }
        result.checks.push({ kind: 'runtime-surface', name: specifier, passed: true, symbols })
      } catch (error) { record(error) }
    }
    for (const name of manifest.dsh?.client?.inject ?? []) {
      try { result.checks.push({ kind: 'browser-artifact', name, passed: true, evidence: await resolveExport(nodeModules, name === '@deepseek-ai/dsh-client-ui-slots' ? name : `${name}/client`) }) }
      catch (error) { record(error) }
    }
    const questions = await load('@deepseek-ai/dsh-user-questions')
    const connection = await load('@deepseek-ai/dsh-client-connection')
    const testkit = await load('@deepseek-ai/dsh-agent-loop-testkit')
    const timedQuestions = typeof questions.isTimedAskUserQuestionSchema === 'function' && typeof questions.UserQuestionService.prototype.askTimed === 'function'
    const principalPeers = typeof connection.Peer === 'function'
    result.capabilities = { timedQuestions, userQuestionProjection: timedQuestions, authorization: principalPeers ? 'browserPeer-owner-principal' : 'operator-peer-identity',
      workingDirectoryTestkit: typeof testkit.provideWorkingDirectoryFixture === 'function', nativeBrowserArtifactsChecked: true, browserExecuted: false }
    if (timedQuestions !== (result.version !== '0.2.0-rc.1')) throw problem('CAPABILITY_MISMATCH', 'Timed question surface differs from the inspected release contract')
    const expectedPrincipal = ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3'].includes(result.version)
    if (principalPeers !== expectedPrincipal) throw problem('CAPABILITY_MISMATCH', 'Peer principal surface differs from the inspected release contract')
    const declaration = async (name, file) => readFile(join((await localPackage(nodeModules, `@deepseek-ai/${name}`)).directory, 'lib/types', file), 'utf8')
    for (const [name, file, pattern, label] of [
      ['dsh-client-ui-workspace', 'client/navigation.d.ts', /openSession\(target:\s*SessionTarget\):\s*void/, 'uiWorkspace.openSession(SessionTarget)'],
      ['dsh-client-connection', 'rpc.d.ts', principalPeers ? /readonly browserPeer:\s*PeerScope/ : /readonly operator:\s*PeerScope/, 'authenticated browser peer'],
      ['dsh-agent', 'runtime-types.d.ts', /followup\(message:\s*UserMessage\):\s*void/, 'Agent.followup(UserMessage)'],
    ]) {
      if (!pattern.test(await declaration(name, file))) throw problem('MISSING_DECLARATION', `${name}: missing ${label}`)
      result.checks.push({ kind: 'declaration', name: label, passed: true, evidence: `${name}/lib/types/${file}` })
    }
    result.ok = result.errors.length === 0
  } catch (error) { record(error) }
  return result
}

export async function writeJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function argumentsOf(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--help') return { help: true }
    if (['--host-root', '--plugin-root', '--version', '--json'].includes(argument)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw problem('INVALID_ARGUMENT', `${argument} needs a value`)
      options[{ '--host-root': 'hostRoot', '--plugin-root': 'sourceRoot', '--version': 'version', '--json': 'json' }[argument]] = value
    } else if (!argument.startsWith('--') && !options.hostRoot) options.hostRoot = argument
    else if (!argument.startsWith('--') && !options.sourceRoot) options.sourceRoot = argument
    else throw problem('INVALID_ARGUMENT', `Unknown argument ${argument}`)
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsOf(process.argv.slice(2))
    if (options.help) console.log('node test/tools/host-surface.mjs [--host-root project-or-node_modules] [--plugin-root source] [--version exact] [--json file|-]')
    else {
      const result = await checkHostSurface(options)
      if (options.json && options.json !== '-') await writeJson(options.json, result)
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = result.ok ? 0 : 1
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'SURFACE_FAILURE', message: error.message }] })); process.exitCode = 1 }
}
