import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript } from '../lib/backend/transcript.js'
import { transcriptSchema } from '../lib/shared/transcript.js'

const user = (seq, time, text, surfaceOp = 'append') => ({ type: 'user/message', seq, time, surfaceOp, data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const assistant = (seq, time, content) => ({ type: 'assistant/message', seq, time, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: `a${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } } } })
const result = (seq, time, text, callId = 'call-1') => ({ type: 'tool/result', seq, time, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `t${seq}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } } } })

test('transcript preview keeps user/assistant/tool content, names tool results and honors surface replacement', () => {
  const events = [
    user(0, 10, 'Hello'),
    assistant(1, 20, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Answer' }, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }]),
    result(2, 30, 'file body'),
    { ...user(3, 40, 'compacted summary'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 } },
  ]
  const value = buildTranscript({}, events)
  assert.equal(value.truncated, false)
  assert.equal(value.messages.length, 1, 'the replaced prefix is not duplicated')
  assert.deepEqual(value.messages[0].parts, [{ type: 'text', text: 'compacted summary' }])

  const fresh = buildTranscript({}, events.slice(0, 3))
  assert.deepEqual(fresh.messages.map(message => message.role), ['user', 'assistant', 'tool'])
  assert.deepEqual(fresh.messages[1].parts.map(part => part.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(fresh.messages[2].parts[0].name, 'read_file', 'a tool result is labeled by the assistant tool call that produced it')
  assert.equal(fresh.messages[2].parts[0].text, 'file body')
})

test('transcript preview bounds the window without dropping tool-error facts', () => {
  const events = Array.from({ length: 125 }, (_, index) => user(index, index, `message ${index}`))
  events.push({ ...result(125, 125, 'failed body'), data: { ...result(125, 125, 'failed body').data, message: { ...result(125, 125, 'failed body').data.message, isError: true } } })
  const value = buildTranscript({}, events)
  assert.equal(value.truncated, true)
  assert.equal(value.messages.length, 120)
  assert.equal(value.messages.at(-1).role, 'tool')
  assert.equal(value.messages.at(-1).parts[0].isError, true)
  assert.equal(value.messages[0].parts[0].text, 'message 6')
})

test('clipped preview parts stay within the shared schema bounds', () => {
  const huge = 'x'.repeat(30000)
  const events = [
    user(0, 10, huge),
    assistant(1, 20, [
      { type: 'reasoning', text: huge },
      { type: 'text', text: huge },
      { type: 'tool-call', id: 'call-1', name: 'n'.repeat(500), arguments: JSON.stringify({ body: huge }) },
    ]),
    result(2, 30, huge),
  ]
  const value = buildTranscript({}, events)
  assert.doesNotThrow(() => transcriptSchema.parse({ sessionId: 'session-test', title: 'test', ...value, coverage: value.truncated ? 'partial' : 'complete', reason: null }))
  const [message] = value.messages
  const assistantParts = value.messages[1].parts
  assert.equal(value.messages[0].parts[0].text.length, 20000)
  assert.equal(assistantParts[0].text.length, 8000)
  assert.equal(assistantParts[1].text.length, 20000)
  assert.equal(assistantParts[2].name.length, 200)
  assert.equal(assistantParts[2].arguments.length, 4000)
  assert.equal(value.messages[2].parts[0].text.length, 12000)
  assert.ok(message.id.length <= 240)
})
