import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHostSurface, inspectInstalledTree, localPackage, readSupportedVersions } from './tools/host-surface.mjs'
import { completeTapRun, copyMatrixRow, manifestForVersion, parseArguments, runMatrix, snapshotProject, sourceFingerprint, tapSummary, testFiles } from './tools/matrix.mjs'
import { npmExecFileSync, npmSpawnSync } from './tools/process.mjs'

test('npm child launch preserves literal arguments, input, stdio and failure status without shell parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-npm launcher-')), cli = join(directory, 'npm-cli.js')
  await writeFile(cli, `const fs = require('node:fs'); const args = process.argv.slice(2); if (args[0] === 'fail') { console.error('fixture npm failure'); process.exit(7) } console.error('fixture stderr'); console.log(JSON.stringify({ args, cwd: process.cwd(), input: fs.readFileSync(0, 'utf8'), marker: process.env.LAUNCHER_TEST_MARKER }))\n`)
  const previous = process.env.npm_execpath
  process.env.npm_execpath = cli
  try {
    const args = ['artifact with spaces.tgz', '标签', 'a&b|c', '$(not-a-command)', '"quoted"', '%PATH%'], options = { cwd: directory, encoding: 'utf8', input: 'literal stdin', env: { ...process.env, LAUNCHER_TEST_MARKER: 'kept' }, stdio: ['pipe', 'pipe', 'pipe'], shell: true }
    const direct = JSON.parse(npmExecFileSync(args, options))
    // Windows may report the 8.3 short form of the same directory, so compare the
    // canonical paths instead of the literal string the child received.
    assert.deepEqual({ ...direct, cwd: await realpath(direct.cwd) }, { args, cwd: await realpath(directory), input: 'literal stdin', marker: 'kept' })
    const spawned = npmSpawnSync(args, options)
    assert.equal(spawned.status, 0); assert.equal(spawned.error, undefined); assert.equal(spawned.signal, null)
    assert.deepEqual(JSON.parse(spawned.stdout), direct); assert.match(spawned.stderr, /fixture stderr/)
    const failed = npmSpawnSync(['fail'], options)
    assert.equal(failed.status, 7); assert.equal(failed.error, undefined); assert.match(failed.stderr, /fixture npm failure/)
    assert.throws(() => npmExecFileSync(['fail'], options), error => error.status === 7 && String(error.stderr).includes('fixture npm failure'))
  } finally { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous }
})

const versions = ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-rc.1', '0.2.1-rc.2']
const fixtureManifest = () => ({ name: 'isolated-matrix-unit', version: '0.0.0', private: true,
  engines: { dsh: versions.join(' || ') },
  peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.0-rc.2', '@deepseek-ai/cordis': '~4.0.4' },
  devDependencies: { '@deepseek-ai/dsh-agent-loop-testkit': '0.2.0-rc.2', '@deepseek-ai/dsh-web-frontend': '0.2.0-rc.2', typescript: '^6.0.3' },
  dependencies: { zod: '^4.4.3' },
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'session-dashboard-matrix-unit-'))
  const source = join(directory, 'project')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`)
  return { directory, source }
}
async function packageAt(modules, name, version) {
  const directory = join(modules, ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }))
  return directory
}

test('matrix accepts exact positional/repeated versions and explicit browser selection only', () => {
  assert.deepEqual(parseArguments(['0.2.0-rc.1', '--version', '0.2.1-rc.2', '--version', '0.2.0-rc.1', '--browser']).versions, ['0.2.0-rc.1', '0.2.1-rc.2'])
  assert.equal(parseArguments([]).browser, false)
  assert.equal(parseArguments(['--chrome', '/tmp/exact-chrome']).browser, true)
  assert.throws(() => parseArguments(['--version']), /needs a value/)
  assert.throws(() => parseArguments(['--force']), /Unknown argument/)
})

test('support list is finite and never admits untested stable/future or range syntax', () => {
  assert.deepEqual(readSupportedVersions(fixtureManifest()), versions)
  for (const range of ['>=0.2.0', '*', '0.2.1-alpha.1 || ^0.2.1']) {
    assert.throws(() => readSupportedVersions({ engines: { dsh: range } }), /exact/)
  }
  assert.throws(() => readSupportedVersions({ engines: { dsh: '0.2.0-rc.1 || 0.2.0-rc.1' } }), /duplicate/)
  assert.throws(() => manifestForVersion(fixtureManifest(), '0.2.1'), /not declared supported/)
  assert.throws(() => manifestForVersion(fixtureManifest(), '0.2.1-alpha.5'), /not declared supported/)
})

test('isolated manifest pins every DSH dependency, adds only published Gateway prerequisites and preserves original pins', () => {
  const original = fixtureManifest()
  const before = JSON.stringify(original)
  const old = manifestForVersion(original, '0.2.0-rc.1')
  const modern = manifestForVersion(original, '0.2.1-rc.2')
  assert.equal(old.peerDependencies['@deepseek-ai/dsh-agent'], '0.2.0-rc.1')
  assert.equal(old.devDependencies['@deepseek-ai/dsh-agent-loop-testkit'], '0.2.0-rc.1')
  assert.equal(old.devDependencies['@deepseek-ai/dsh-web-frontend'], '0.2.0-rc.1')
  assert.equal(modern.devDependencies['@deepseek-ai/dsh-web-frontend'], '0.2.1-rc.2')
  assert.equal(old.devDependencies['@deepseek-ai/dsh-api-remote-access'], undefined)
  assert.equal(modern.devDependencies['@deepseek-ai/dsh-api-remote-access'], '0.2.1-rc.2')
  assert.equal(modern.peerDependencies['@deepseek-ai/cordis'], original.peerDependencies['@deepseek-ai/cordis'])
  assert.equal(JSON.stringify(original), before)
})

test('snapshot excludes generated modules/dependencies and rows cannot rewrite original package or lock', async () => {
  const { source, directory } = await fixture()
  await mkdir(join(source, 'src'))
  await writeFile(join(source, 'src/entry.ts'), 'export const maintained = true\n')
  await writeFile(join(source, 'package-lock.json'), '{"originalLock":true}\n')
  for (const name of ['lib', 'node_modules', '.git', 'artifacts']) {
    await mkdir(join(source, name))
    await writeFile(join(source, name, 'must-not-copy'), name)
  }
  const before = await sourceFingerprint(source)
  const snapshot = join(directory, 'snapshot')
  const result = await snapshotProject(source, snapshot)
  assert.equal(result.sha256, before.sha256)
  assert.deepEqual((await readdir(snapshot)).sort(), ['package-lock.json', 'package.json', 'src'])
  await writeFile(join(snapshot, 'package.json'), JSON.stringify(manifestForVersion(fixtureManifest(), '0.2.1-rc.2')))
  assert.equal((await sourceFingerprint(source)).sha256, before.sha256)
  assert.equal(await readFile(join(source, 'package-lock.json'), 'utf8'), '{"originalLock":true}\n')
})

test('actual row copy omits only the baseline root lock, keeping source locks immutable', async () => {
  const { source, directory } = await fixture()
  const baseline = '{"lockedSdk":"0.2.0-rc.2"}\n'
  await writeFile(join(source, 'package-lock.json'), baseline)
  await mkdir(join(source, 'test/fixtures'), { recursive: true })
  await writeFile(join(source, 'test/fixtures/package-lock.json'), 'nested fixture lock\n')
  const snapshot = join(directory, 'snapshot')
  await snapshotProject(source, snapshot)
  const row = join(directory, 'row')
  await copyMatrixRow(snapshot, row)
  await assert.rejects(readFile(join(row, 'package-lock.json')), error => error.code === 'ENOENT')
  assert.equal(await readFile(join(row, 'test/fixtures/package-lock.json'), 'utf8'), 'nested fixture lock\n')
  assert.equal(await readFile(join(source, 'package-lock.json'), 'utf8'), baseline)
  assert.equal(await readFile(join(snapshot, 'package-lock.json'), 'utf8'), baseline)
  // Normal npm is free to write this row's independently resolved exact graph.
  await writeFile(join(row, 'package-lock.json'), '{"lockedSdk":"0.2.1-rc.2"}\n')
  assert.equal(await readFile(join(snapshot, 'package-lock.json'), 'utf8'), baseline)
})

test('missing explicit SDK cannot fall back to the current/global host', async () => {
  const { source, directory } = await fixture()
  const host = join(directory, 'missing')
  await mkdir(join(host, 'node_modules'), { recursive: true })
  const result = await checkHostSurface({ sourceRoot: source, hostRoot: host, version: '0.2.0-rc.1' })
  assert.equal(result.ok, false)
  assert(result.errors.some(error => error.code === 'MISSING_DEPENDENCY'))
  assert.equal(result.imports.length, 0)
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./tools/host-surface.mjs', import.meta.url)), '--plugin-root', source, '--host-root', host, '--version', '0.2.0-rc.1'], { encoding: 'utf8' })
  assert.equal(cli.status, 1, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).ok, false)
})

test('unsupported matrix request writes machine-readable rejection without install or behavior claims', async () => {
  const { source, directory } = await fixture()
  const before = await sourceFingerprint(source)
  const output = join(directory, 'result.json')
  const report = await runMatrix({ sourceRoot: source, output, versions: ['0.2.1'] })
  assert.equal(report.ok, false)
  assert.equal(report.results[0].status, 'rejected')
  assert.equal(report.results[0].nodeBehavior, 'not-run')
  assert.equal(report.snapshot, null)
  assert.equal(report.results[0].steps.length, 0)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).errors[0].code, 'UNSUPPORTED_VERSION')
  assert.equal((await sourceFingerprint(source)).sha256, before.sha256)
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./tools/matrix.mjs', import.meta.url)), '999.999.999', '--output', join(directory, 'cli.json')], { encoding: 'utf8' })
  assert.equal(cli.status, 1, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).ok, false)
})

test('browser discovery tolerates asset-only subdirectories and refuses an empty suite', async () => {
  const { directory } = await fixture()
  await mkdir(join(directory, 'browser/fonts'), { recursive: true })
  await writeFile(join(directory, 'browser/fonts/source.json'), '{}')
  await assert.rejects(testFiles(join(directory, 'browser'), true), /No behavioral tests/)
  const expected = join(directory, 'browser/dashboard.test.mjs')
  await writeFile(expected, '/* fixture only, never run */')
  const nativeSidebar = join(directory, 'browser/native-sidebar.test.mjs'), nested = join(directory, 'browser/product/flow.test.mjs')
  await writeFile(nativeSidebar, '/* native Chrome fixture test */')
  await mkdir(join(directory, 'browser/product'))
  await writeFile(nested, '/* nested Chrome behavior */')
  assert.deepEqual(await testFiles(join(directory, 'browser'), true), [expected, nativeSidebar, nested])
  assert.deepEqual(tapSummary('# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'), { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 })
})

test('matrix behavior evidence refuses empty, partial, skipped and todo test runs', () => {
  const passed = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 }
  assert.equal(completeTapRun(passed), true)
  for (const changed of [{ tests: 0, pass: 0 }, { pass: 2 }, { fail: 1 }, { cancelled: 1 }, { skipped: 1 }, { todo: 1 }]) assert.equal(completeTapRun({ ...passed, ...changed }), false)
  assert.equal(completeTapRun({ tests: 3, pass: 3, fail: 0 }), false, 'missing TAP totals cannot claim full execution')
})

test('explicit missing SDK cache fails a real matrix row without npm fallback, build, or behavior', async () => {
  const { source, directory } = await fixture()
  const before = await sourceFingerprint(source)
  const output = join(directory, 'cache-failure.json')
  const report = await runMatrix({ sourceRoot: source, output, versions: ['0.2.0-rc.1'], sdkCache: join(directory, 'absent-cache') })
  assert.equal(report.ok, false)
  assert.equal(report.results[0].status, 'failed')
  assert.equal(report.results[0].steps.length, 0, 'no install or behavior subprocess is permitted after explicit cache failure')
  assert.equal(report.results[0].nodeBehavior, 'not-run')
  assert.equal(report.results[0].errors[0].code, 'MISSING_DEPENDENCY')
  assert(report.negativeCases.every(result => result.passed))
  assert.equal((await sourceFingerprint(source)).sha256, before.sha256)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).results[0].status, 'failed')
})

test('recursive exact-tree check rejects hidden mixed-version DSH copies', async () => {
  const { directory } = await fixture()
  const modules = join(directory, 'node_modules')
  const parent = await packageAt(modules, '@deepseek-ai/dsh-agent', '0.2.0-rc.1')
  await packageAt(join(parent, 'node_modules'), '@deepseek-ai/dsh-session', '0.2.1-rc.2')
  await assert.rejects(inspectInstalledTree(modules, '0.2.0-rc.1'), error => error.code === 'MIXED_DSH_VERSIONS')
})

test('explicit host package links escaping its tree are rejected rather than loaded', async () => {
  const { directory } = await fixture()
  const modules = join(directory, 'node_modules')
  const outside = await packageAt(join(directory, 'outside'), '@deepseek-ai/dsh-agent', '0.2.0-rc.1')
  await mkdir(join(modules, '@deepseek-ai'), { recursive: true })
  await symlink(outside, join(modules, '@deepseek-ai/dsh-agent'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(localPackage(modules, '@deepseek-ai/dsh-agent'), error => error.code === 'OUTSIDE_HOST_ROOT')
  await assert.rejects(inspectInstalledTree(modules, '0.2.0-rc.1'), error => error.code === 'OUTSIDE_HOST_ROOT')
})
