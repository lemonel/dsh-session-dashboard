import { existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { posix, win32 } from 'node:path'

/** Launch the standard npm JavaScript CLI with this Node executable. In
 * particular, .cmd files are never passed to execFile/spawn on Windows and no
 * shell interpolation is needed for paths containing spaces or metacharacters.
 * The optional facts are a pure test seam, not a global process.platform patch. */
export function npmCommand({ nodeExecutable = process.execPath, npmExecPath = process.env.npm_execpath, platform = process.platform, exists = existsSync } = {}) {
  const path = platform === 'win32' ? win32 : posix
  const bin = path.dirname(nodeExecutable)
  const candidates = npmExecPath ? [npmExecPath] : [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(bin, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find(candidate => path.isAbsolute(candidate) && /(?:^|[\\/])npm-cli\.(?:[cm]?js)$/.test(candidate) && exists(candidate))
  if (!cli) throw Object.assign(new Error(npmExecPath
    ? 'The explicit npm_execpath is not an available npm JavaScript CLI; refusing a shell or unrelated fallback'
    : 'Cannot locate npm-cli.js in the standard Node installation; run this tool through npm or install a standard Node distribution'), { code: 'NPM_CLI_UNAVAILABLE' })
  return { command: nodeExecutable, prefix: [cli] }
}

/** Keep execFileSync's stdout, stdio, input and throwing-on-nonzero semantics. */
export function npmExecFileSync(args, options = {}) {
  const { command, prefix } = npmCommand()
  return execFileSync(command, [...prefix, ...args], { ...options, shell: false })
}
/** Keep spawnSync's status/error/signal result so matrix evidence is unchanged. */
export function npmSpawnSync(args, options = {}) {
  const { command, prefix } = npmCommand()
  return spawnSync(command, [...prefix, ...args], { ...options, shell: false })
}
