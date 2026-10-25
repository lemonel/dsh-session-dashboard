import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceHeaderDigest, sourceIdentityVariants } from '../lib/backend/lifecycle.js'

const base = { version: 4, id: 'session-identity', createdAt: 1, cwd: '/work', isSeeded: false, agentPreset: 'standard' }

test('source identity is independent of delegationDepth property order', () => {
  const depthFirst = { ...base, delegationDepth: 0 }
  const presetFirst = (({ delegationDepth, ...rest }) => ({ ...rest, agentPreset: base.agentPreset, delegationDepth: 0 }))(depthFirst)
  const a = sourceIdentityVariants(depthFirst, 0)
  const b = sourceIdentityVariants(presetFirst, 0)
  assert.equal(a.identity, b.identity)
  assert.equal(sourceHeaderDigest(depthFirst, 0), sourceHeaderDigest(presetFirst, 0))
})

test('the pre-delegationDepth header shape remains a compatibility identity only', () => {
  const header = { ...base, delegationDepth: 0 }
  const variants = sourceIdentityVariants(header, 0)
  const { delegationDepth, ...withoutDepth } = header
  assert.equal(variants.legacy.length, 1)
  assert.notEqual(variants.legacy[0], variants.identity)
  assert.notEqual(withoutDepth.delegationDepth, 0)
})
