#!/usr/bin/env node
// Exact SDK matrix. Only isolated copies receive new pins, installs and builds.
// Usage: node test/tools/matrix.mjs [version ...] [--version version] [--browser]
//        [--chrome executable] [--sdk-cache directory] [--output JSON-file]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHostSurface, inspectInstalledTree, isDshPackage, localNodeModules, pluginRoot, readSupportedVersions, writeJson } from './host-surface.mjs'
import { npmCommand } from './process.mjs'

const PRINCIPAL_VERSIONS = new Set(['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3'])
const EXCLUDED = new Set(['.git', 'node_modules', 'lib', 'artifacts', '.DS_Store'])
const failure = (code, message) => Object.assign(new Error(message), { code })

export function parseArguments(args) {
  const options = { versions: [], browser: false }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--help') options.help = true
    else if (argument === '--browser') options.browser = true
    else if (['--version', '--chrome', '--sdk-cache', '--output'].includes(argument)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw failure('INVALID_ARGUMENT', `${argument} needs a value`)
      if (argument === '--version') options.versions.push(value)
      else if (argument === '--chrome') { options.chrome = resolve(value); options.browser = true }
      else if (argument === '--sdk-cache') options.sdkCache = resolve(value)
      else options.output = resolve(value)
    } else if (argument.startsWith('--')) throw failure('INVALID_ARGUMENT', `Unknown argument ${argument}`)
    else options.versions.push(argument)
  }
  options.versions = [...new Set(options.versions)]
  return options
}

/** Remap only the isolated manifest; original package/lock and source stay intact. */
export function manifestForVersion(original, version) {
  if (!readSupportedVersions(original).includes(version)) throw failure('UNSUPPORTED_VERSION', `DSH ${version} is not declared supported; no install attempted`)
  const manifest = structuredClone(original)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (manifest[field]) for (const name of Object.keys(manifest[field])) if (isDshPackage(name)) manifest[field][name] = version
  }
  // The old releases do not publish this package. It is a real Gateway test
  // prerequisite starting at alpha.3, not an invented production peer or stub.
  if (PRINCIPAL_VERSIONS.has(version)) {
    manifest.devDependencies ??= {}
    manifest.devDependencies['@deepseek-ai/dsh-api-remote-access'] = version
  }
  return manifest
}

function include(path) {
  const parts = path.split(/[\\/]/)
  return !parts.some(part => EXCLUDED.has(part)) && !path.endsWith('.tgz')
}

export async function sourceFingerprint(root) {
  const files = []
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const rel = relative(root, path)
      if (!include(rel)) continue
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw failure('SOURCE_SYMLINK', `Source snapshot refuses a link outside its controlled inputs: ${rel}`)
      if (info.isDirectory()) { await visit(path); continue }
      if (!info.isFile()) throw failure('SOURCE_SPECIAL_FILE', `Not a regular source file: ${rel}`)
      files.push({ path: rel, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
    }
  }
  await visit(root)
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

/** A changing shared checkout is an error, never an accidental mixed snapshot. */
export async function snapshotProject(source, destination) {
  const before = await sourceFingerprint(source)
  await cp(source, destination, { recursive: true, filter: path => include(relative(source, path)) })
  const [after, copied] = await Promise.all([sourceFingerprint(source), sourceFingerprint(destination)])
  if (before.sha256 !== after.sha256 || before.sha256 !== copied.sha256) throw failure('SOURCE_CHANGED', 'Source changed while snapshotting; wait for its owner to finish and rerun')
  return { directory: destination, sha256: copied.sha256, files: copied.files.length }
}

export async function testFiles(directory, recursive = false) {
  const results = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory() && recursive) await visit(child)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) results.push(child)
    }
  }
  await visit(directory)
  if (!results.length) throw failure('MISSING_BEHAVIOR_TESTS', `No behavioral tests found at ${directory}`)
  return results.sort()
}

export function tapSummary(text) {
  const summary = {}
  for (const [, name, count] of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) summary[name] = Number(count)
  return summary
}

/** A requested real-browser row cannot pass by skipping its native components. */
export function completeTapRun(counts) {
  return counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0
}

function execute(command, args, directory, env, logPath, stage) {
  if (command === 'npm') {
    const npm = npmCommand()
    command = npm.command; args = [...npm.prefix, ...args]
  }
  const start = Date.now()
  const descriptor = openSync(logPath, 'w')
  let processResult
  try { processResult = spawnSync(command, args, { cwd: directory, env, timeout: stage === 'install' ? 600_000 : 300_000,
    stdio: ['ignore', descriptor, descriptor], shell: false }) }
  finally { closeSync(descriptor) }
  const result = { stage, command: [command, ...args], exitCode: processResult.status, signal: processResult.signal, durationMs: Date.now() - start, log: logPath,
    passed: processResult.status === 0 && !processResult.error }
  if (processResult.error) result.error = processResult.error.message
  return result
}

/** The baseline lock remains immutable evidence in the snapshot. Its rc.2
 * peer graph cannot be reused for other exact releases: npm must generate a
 * fresh row-local lock from the remapped manifest, without peer bypasses. */
export async function copyMatrixRow(snapshot, rowDirectory) {
  await cp(snapshot, rowDirectory, { recursive: true,
    filter: path => relative(snapshot, path) !== 'package-lock.json' })
}

async function negativeCases(sourceRoot, directory, supported) {
  const empty = join(directory, 'missing-sdk')
  await mkdir(join(empty, 'node_modules'), { recursive: true })
  let unsupported = '999.999.999-unsupported.1'
  while (supported.includes(unsupported)) unsupported += '.1'
  const rejected = await checkHostSurface({ sourceRoot, hostRoot: empty, version: unsupported })
  const missing = await checkHostSurface({ sourceRoot, hostRoot: empty, version: supported[0] })
  return [
    { name: 'unsupported-version', expected: 'rejected-before-install', testedVersion: unsupported,
      passed: !rejected.ok && rejected.errors.some(error => error.code === 'UNSUPPORTED_VERSION'), evidence: rejected.errors },
    { name: 'missing-local-dependencies', expected: 'fail-without-global-fallback',
      passed: !missing.ok && missing.errors.some(error => error.code === 'MISSING_DEPENDENCY'), evidence: missing.errors },
  ]
}

/** Preserve every isolated row and its logs, including failures, for diagnosis. */
export async function runMatrix(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? pluginRoot)
  const output = resolve(options.output ?? join(sourceRoot, 'artifacts/compatibility.json'))
  const report = { schemaVersion: 1, kind: 'session-dashboard-compatibility', status: 'running', ok: false,
    createdAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform,
    sourceRoot, output, browserRequested: Boolean(options.browser), chrome: options.chrome ?? process.env.CHROME_PATH ?? null,
    supportedVersions: [], requestedVersions: [], snapshot: null, negativeCases: [], results: [], errors: [] }
  const save = () => writeJson(output, report)
  try {
    const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
    const supported = report.supportedVersions = readSupportedVersions(manifest)
    const requested = report.requestedVersions = options.versions?.length ? [...new Set(options.versions)] : supported
    // Exact supported list rejects unknown/future requests without querying npm.
    const unknown = requested.filter(version => !supported.includes(version))
    if (unknown.length) {
      report.results.push(...unknown.map(version => ({ version, status: 'rejected', expectedSupport: 'unsupported', reason: 'Not in engines.dsh exact union; no install attempted', steps: [], nodeBehavior: 'not-run', browser: 'not-run' })))
      throw failure('UNSUPPORTED_VERSION', `Unsupported matrix versions: ${unknown.join(', ')}`)
    }
    const directory = await mkdtemp(join(tmpdir(), 'session-dashboard-matrix-'))
    report.directory = await realpath(directory)
    const snapshot = join(directory, 'snapshot')
    report.snapshot = await snapshotProject(sourceRoot, snapshot)
    report.negativeCases = await negativeCases(snapshot, join(directory, 'negatives'), supported)
    if (report.negativeCases.some(result => !result.passed)) throw failure('NEGATIVE_CASE_FAILED', 'A fail-closed dependency/version check did not reject')
    await save()
    for (const version of requested) {
      const rowDirectory = join(directory, version)
      const row = { version, expectedSupport: 'supported', status: 'running', directory: rowDirectory,
        dependencySource: 'npm-exact-install', inheritedBuildOutputs: false, steps: [], surface: null, nodeBehavior: 'not-run', browser: options.browser ? 'not-run' : 'not-requested', errors: [] }
      report.results.push(row)
      try {
        await copyMatrixRow(snapshot, rowDirectory)
        const isolatedManifest = manifestForVersion(manifest, version)
        await writeFile(join(rowDirectory, 'package.json'), `${JSON.stringify(isolatedManifest, null, 2)}\n`)
        const logs = join(rowDirectory, 'artifacts/matrix')
        await mkdir(logs, { recursive: true })
        const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', INIT_CWD: rowDirectory, DSH_MATRIX_VERSION: version }
        if (options.chrome) env.CHROME_PATH = options.chrome
        const cache = options.sdkCache ?? process.env.DSH_MATRIX_SDK_CACHE
        if (cache) {
          // An explicitly selected cache is authoritative: a missing/incoherent
          // cache fails. We never silently replace it with another installed SDK.
          const cachedModules = await localNodeModules(join(resolve(cache), version))
          await inspectInstalledTree(cachedModules, version)
          await cp(cachedModules, join(rowDirectory, 'node_modules'), { recursive: true, dereference: false })
          row.dependencySource = `verified-cache-copy+exact-npm-install:${cachedModules}`
        }
        const run = async (command, args, stage) => {
          const step = execute(command, args, rowDirectory, env, join(logs, `${stage}.log`), stage)
          row.steps.push(step)
          if (stage.endsWith('-tests')) {
            step.testCounts = tapSummary(await readFile(step.log, 'utf8'))
            if (!completeTapRun(step.testCounts)) step.passed = false
          }
          await save()
          if (!step.passed) throw failure('STAGE_FAILED', `${version}: ${stage} failed (exit ${step.exitCode ?? step.signal ?? step.error}); see ${step.log}`)
          return step
        }
        // Official npm dependencies may run their normal install lifecycle. No
        // --force, legacy-peer-deps, global SDK, or scripts from foreign repos.
        await run('npm', ['install', '--engine-strict', '--prefer-offline', '--no-audit', '--no-fund'], 'install')
        try {
          await run(process.execPath, ['test/tools/host-surface.mjs', '--host-root', rowDirectory, '--plugin-root', rowDirectory, '--version', version, '--json', join(logs, 'surface.json')], 'surface')
        } finally {
          const surfaceJson = await readFile(join(logs, 'surface.json'), 'utf8').catch(() => null)
          if (surfaceJson !== null) row.surface = JSON.parse(surfaceJson)
        }
        await run('npm', ['run', 'build'], 'build')
        const tests = await run(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', ...await testFiles(join(rowDirectory, 'test'))], 'node-tests')
        row.nodeBehavior = tests.passed ? 'passed' : 'failed'
        if (options.browser) {
          row.browserTestFiles = await testFiles(join(rowDirectory, 'test/browser'), true)
          await run(process.execPath, [join(rowDirectory, 'test/tools/browser-suite.mjs'), ...row.browserTestFiles], 'chrome-tests')
          row.browser = 'passed'
        }
        row.status = 'passed'
      } catch (error) {
        row.errors.push({ code: error.code ?? 'MATRIX_FAILURE', message: error.message })
        if (row.steps.some(step => step.stage === 'node-tests' && !step.passed)) row.nodeBehavior = 'failed'
        if (row.steps.some(step => step.stage === 'chrome-tests' && !step.passed)) row.browser = 'failed'
        row.status = 'failed'
      }
      console.error(`[matrix] DSH ${version}: ${row.status.toUpperCase()} (behavior=${row.nodeBehavior}, browser=${row.browser}) ${rowDirectory}`)
      await save()
    }
    // Snapshot is immutable; row manifests differ but maintained source does not.
    if ((await sourceFingerprint(snapshot)).sha256 !== report.snapshot.sha256) throw failure('SNAPSHOT_CHANGED', 'The immutable source snapshot was modified during the matrix')
    report.ok = report.results.length === requested.length && report.results.every(row => row.status === 'passed') && report.negativeCases.every(result => result.passed)
    report.status = report.ok ? 'passed' : 'failed'
  } catch (error) {
    report.errors.push({ code: error.code ?? 'MATRIX_FAILURE', message: error.message })
    report.status = 'failed'
  }
  report.finishedAt = new Date().toISOString()
  await save()
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) console.log('node test/tools/matrix.mjs [exact-version ...] [--version exact-version] [--browser] [--chrome executable] [--sdk-cache directory] [--output JSON-file]')
    else {
      const report = await runMatrix(options)
      console.log(JSON.stringify({ ok: report.ok, status: report.status, output: report.output, directory: report.directory, results: report.results.map(({ version, status, nodeBehavior, browser }) => ({ version, status, nodeBehavior, browser })), errors: report.errors }, null, 2))
      process.exitCode = report.ok ? 0 : 1
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 }
}
