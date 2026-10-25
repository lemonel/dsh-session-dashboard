import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { browserRequestId } from '../lib/frontend/request-id.js'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function useCrypto(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto })
}

test('request ID prefers native randomUUID, binds its receiver and never calls fallback', t => {
  const expected = '00112233-4455-4677-8899-aabbccddeeff'
  let calls = 0
  const source = {
    randomUUID(...args) { assert.equal(this, source); assert.deepEqual(args, []); calls++; return expected },
    getRandomValues() { assert.fail('Native UUID must take precedence') },
  }
  useCrypto(t, source)
  assert.equal(browserRequestId(), expected)
  assert.equal(calls, 1)
})

test('request ID fallback fills exactly 16 bytes with the bound CSPRNG and formats lowercase v4', t => {
  const source = { getRandomValues(bytes) {
    assert.equal(this, source); assert(bytes instanceof Uint8Array); assert.equal(bytes.byteLength, 16)
    bytes.set(Array.from({ length: 16 }, (_, index) => index)); return bytes
  } }
  useCrypto(t, source)
  assert.equal(browserRequestId(), '00010203-0405-4607-8809-0a0b0c0d0e0f')
})

test('request ID fallback preserves all 122 random bits and replaces only version/variant bits', t => {
  let input = new Uint8Array(16)
  const source = { getRandomValues(bytes) { bytes.set(input); return bytes } }
  useCrypto(t, source)
  const outputBytes = () => {
    const id = browserRequestId(); assert.match(id, uuidV4)
    return Uint8Array.from(Buffer.from(id.replaceAll('-', ''), 'hex'))
  }
  assert.deepEqual(outputBytes(), Uint8Array.from([0, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 0]))
  input.fill(0xff)
  assert.equal(browserRequestId(), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  for (let bit = 0; bit < 128; bit++) {
    input = new Uint8Array(16); input[bit >> 3] = 1 << (bit % 8)
    const output = outputBytes()
    for (let position = 0; position < 128; position++) {
      const mask = 1 << (position % 8), byte = position >> 3
      const expected = byte === 6 && mask >= 0x10 ? mask === 0x40 : byte === 8 && mask >= 0x40 ? mask === 0x80 : position === bit
      assert.equal(Boolean(output[byte] & mask), expected, `input bit ${bit}, output bit ${position}`)
    }
  }
})

test('request ID fallback produces 50000 unique valid UUIDs from real Web Crypto', t => {
  useCrypto(t, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  const ids = new Set()
  for (let index = 0; index < 50000; index++) { const id = browserRequestId(); assert.match(id, uuidV4); ids.add(id) }
  assert.equal(ids.size, 50000)
})

test('request ID fails closed without crypto or either callable secure capability', t => {
  useCrypto(t, undefined)
  for (const value of [undefined, null, {}, { randomUUID: undefined, getRandomValues: undefined }, { randomUUID: 'not callable', getRandomValues: null }]) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
    assert.throws(() => browserRequestId(), /Cryptographically secure randomness is unavailable/)
  }
  delete globalThis.crypto
  assert.throws(() => browserRequestId(), /Cryptographically secure randomness is unavailable/)
})

test('request ID propagates the exact random-source error without downgrade or weak fallback', t => {
  const nativeError = new Error('native CSPRNG failed'), fallbackError = new Error('getRandomValues failed')
  useCrypto(t, { randomUUID() { throw nativeError }, getRandomValues() { assert.fail('A broken native source must not silently downgrade') } })
  assert.throws(() => browserRequestId(), error => error === nativeError)
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues() { throw fallbackError } } })
  assert.throws(() => browserRequestId(), error => error === fallbackError)
})
