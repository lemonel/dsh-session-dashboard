import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('./', import.meta.url))
const output = resolve(root, 'lib')
// Check the only destructive path before removing generated artifacts.
if (output !== resolve(dirname(fileURLToPath(import.meta.url)), 'lib') || dirname(output) !== resolve(root)) throw new Error('Unexpected output path')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
// Explicit maintained entry mapping: src/backend_index.ts -> lib/backend_index.js
// (tsc above); src/frontend_index.ts and dependencies -> lib/client.js (ModuleLoader).
const result = await build({ entryPoints: [resolve(root, 'src/frontend_index.ts')], bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022', charset: 'utf8', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'] })
const text = result.outputFiles[0]?.text
if (!text) throw new Error('No browser bundle output')
const manifest = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'))
await writeFile(resolve(output, 'client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${text}\nreturn module.exports;}});\n`)
console.error('Built strict host modules, RPC descriptors, and native dashboard client.')
