import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshotProject, sourceFingerprint } from './matrix.mjs'
import { npmExecFileSync } from './process.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const workspace = await mkdtemp(join(tmpdir(), 'session-dashboard-clean-'))
// Capture all maintained resources, including untracked tests and both READMEs.
// Concurrent edits, external symlinks and inherited outputs fail closed.
// This is a clean fixed SOURCE snapshot, explicitly not a Git checkout.
const source = join(workspace, 'source')
const snapshot = await snapshotProject(root, source)
const destination = join(workspace, 'verification')
await snapshotProject(source, destination)
const before = await readdir(destination)
assert(!before.includes('lib') && !before.includes('node_modules'))
const run = args => npmExecFileSync(args, { cwd: destination, stdio: 'inherit', env: { ...process.env, NODE_PATH: '', INIT_CWD: destination } })
console.log(`Clean source verification in ${destination}`)
run(['ci', '--prefer-offline', '--no-audit', '--no-fund'])
run(['test'])
run(['run', 'check:package'])
// Browser executable is explicit and native; no network/mock GUI replacement server.
if (process.env.DSH_CLEAN_BROWSER === '1') run(['run', 'test:browser'])
const artifacts = join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))
assert.equal((await sourceFingerprint(source)).sha256, snapshot.sha256, 'Immutable clean source snapshot changed during verification')
const result = { packageName: manifest.name, version: manifest.version, source: destination, sourceSnapshot: snapshot, gitCheckout: false, lockedInstall: true, inheritedBuildOutputs: false, tests: true, packedRuntime: true, browser: process.env.DSH_CLEAN_BROWSER === '1' }
await writeFile(join(artifacts, 'clean-verification.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
// Preserve the isolated workspace for inspection; never delete an unverified computed path.
