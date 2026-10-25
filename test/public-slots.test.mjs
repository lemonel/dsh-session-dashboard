import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const typescript = join(root, 'node_modules/typescript/bin/tsc')

test('N06 independent strict TypeScript consumer uses exported slot entry and native registration types', async () => {
  // Keep resolution under this package's public self reference while using an
  // independent consumer module, not src imports or source-text augmentation.
  const directory = await mkdtemp(join(root, 'test/.public-slot-consumer-'))
  try {
    const contract = `import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { withContributionBoundary } from '@hsx/dsh-session-dashboard/slots'
import type { DashboardCardOwner, DashboardGlobalOwner, DashboardSlotContext } from '@hsx/dsh-session-dashboard/slots'
export function register(ctx: Context): () => void {
  const CardBadge = withContributionBoundary('@fixture/public-consumer:badge', (props: DashboardCardOwner) => createElement('span', { 'data-member': props.card.membershipId, 'data-occurrence': props.occurrenceId }, props.card.title))
  const Global = ({ context }: DashboardGlobalOwner) => createElement('span', {}, context.handshake?.serviceId ?? 'waiting')
  const menu = (props: DashboardCardOwner) => createElement('button', { onClick: () => { void props.actions.requestReview() } }, '核对')
  const stops = [ctx.slots.register({ name: 'session-dashboard.card.badge', id: '@fixture/public-consumer:badge' }, CardBadge), ctx.slots.register({ name: 'session-dashboard.toolbar.action', id: '@fixture/public-consumer:toolbar' }, Global), ctx.slots.register({ name: 'session-dashboard.card.menu.item', id: '@fixture/public-consumer:menu' }, menu)]
  return () => { for (const stop of stops) stop() }
}
export const scope: DashboardSlotContext['entry'] = 'board'
`
    await writeFile(join(directory, 'consumer.ts'), contract)
    // The maintained browser contributor must also typecheck against public exports;
    // esbuild alone would not detect broken declaration or owner intersections.
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', jsx: 'react-jsx', skipLibCheck: true, types: ['node'], verbatimModuleSyntax: true }, files: ['consumer.ts', '../browser/slot-contribution.tsx'] }))
    try { await exec(process.execPath, [typescript, '--project', join(directory, 'tsconfig.json')], { cwd: root }) }
    catch (error) { throw new Error(`Public slot consumer compilation failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }) }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.exports['./slots'].types, './lib/frontend/public_slots.d.ts')
    assert.equal(manifest.exports['./slots'].default, './lib/frontend/public_slots.js')
  } finally {
    const target = await realpath(directory)
    assert.equal(dirname(target), resolve(root, 'test'))
    assert.match(target.slice(dirname(target).length + 1), /^\.public-slot-consumer-/)
    await rm(target, { recursive: true, force: true })
  }
})
