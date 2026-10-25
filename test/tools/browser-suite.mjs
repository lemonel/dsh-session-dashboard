#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// One browser test file per process, with a single rerun of a file that failed.
// A shared two-core runner can land a viewport change or a native catalogue event
// between two awaits, so a timing wobble in one file must not redden a green
// change. A deterministic failure still fails: the rerun gets the same suite.
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const attempts = Math.max(1, Number(process.env.BROWSER_SUITE_ATTEMPTS ?? 2))
const requested = process.argv.slice(2).filter(argument => argument.endsWith('.test.mjs'))
const files = requested.length
  ? requested
  : (await readdir(join(root, 'test/browser'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('test/browser', name))
assert(files.length > 0, 'No browser test files selected')
const failures = []
for (const file of files) {
  let passed = false
  for (let attempt = 1; attempt <= attempts && !passed; attempt += 1) {
    try {
      const { stdout, stderr } = await exec(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      if (attempt > 1) process.stdout.write(`[browser] retried and passed: ${file}\n`)
      passed = true
    } catch (error) {
      if (attempt === attempts) failures.push({ file, output: `${error.stdout ?? ''}${error.stderr ?? ''}` })
    }
  }
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`[browser] failed on every attempt: ${failure.file}\n${failure.output}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`[browser] ${files.length} file(s) passed${attempts > 1 ? ' (one rerun allowed per file)' : ''}\n`)
}
