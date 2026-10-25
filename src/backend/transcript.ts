import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptMessage, TranscriptPart } from '../shared/transcript.js'

/** Preview bounds: a dialog, not an archive. Tool output is the loudest content in a
 *  session log, so it is capped harder than human/assistant prose. */
const MAX_MESSAGES = 120
const MAX_TEXT = 20000
const MAX_REASONING = 8000
const MAX_TOOL = 12000
const MAX_ARGUMENTS = 4000

const clip = (value: string, limit: number): string => value.length > limit ? (limit > 0 ? `${value.slice(0, limit - 1)}…` : '') : value
const meaningful = (value: string): boolean => value.trim().length > 0

function partsOf(blocks: readonly ContentBlock[], toolNames: Map<string, string>): TranscriptPart[] {
  const parts: TranscriptPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text': if (meaningful(block.text)) parts.push({ type: 'text', text: clip(block.text, MAX_TEXT) }); break
      case 'reasoning': if (meaningful(block.text)) parts.push({ type: 'reasoning', text: clip(block.text, MAX_REASONING) }); break
      case 'tool-call': toolNames.set(block.id, block.name); parts.push({ type: 'tool-call', name: clip(block.name, 200), arguments: clip(block.arguments, MAX_ARGUMENTS) }); break
      case 'image': parts.push({ type: 'attachment', kind: 'image', name: block.attachment.name ? clip(block.attachment.name, 500) : null }); break
      case 'file': parts.push({ type: 'attachment', kind: 'file', name: clip(block.attachment.name, 500) }); break
      default: break
    }
  }
  return parts
}

/** Derive a bounded, user-facing conversation from the durable/session event log.
 *  Surface replacement (compaction) removes the nodes it shadows instead of showing
 *  duplicated history. System/developer/request/lifecycle events are intentionally not
 *  part of an "open the conversation" preview. */
export function buildTranscript(_header: SessionHeader, events: readonly SessionEvent[]): { messages: TranscriptMessage[]; truncated: boolean } {
  const entries: { seq: number; message: TranscriptMessage }[] = [], toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const { startSeq, endSeq } = event.surfaceOp
      for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].seq >= startSeq && entries[index].seq <= endSeq) entries.splice(index, 1)
    }
    let role: TranscriptMessage['role'], id: string, time: number, parts: TranscriptPart[]
    if (event.type === 'user/message') {
      role = 'user'; id = event.data.id; time = event.time
      parts = partsOf(event.data.content, toolNames)
    } else if (event.type === 'assistant/message') {
      role = 'assistant'; id = event.data.message.id; time = event.time
      parts = partsOf(event.data.message.content, toolNames)
    } else {
      role = 'tool'; id = event.data.message.id; time = event.time
      const name = toolNames.get(event.data.message.toolCallId)
      const text = event.data.message.content.flatMap(block => block.type === 'text' || block.type === 'reasoning' ? [block.text] : []).join('\n')
      parts = []
      if (meaningful(text)) parts.push({ type: 'tool-result', name: name ? clip(name, 200) : null, text: clip(text, MAX_TOOL), isError: event.data.message.isError === true })
      for (const block of event.data.message.content) {
        if (block.type === 'image') parts.push({ type: 'attachment', kind: 'image', name: block.attachment.name ? clip(block.attachment.name, 500) : null })
        else if (block.type === 'file') parts.push({ type: 'attachment', kind: 'file', name: clip(block.attachment.name, 500) })
      }
    }
    if (parts.length > 0) entries.push({ seq: event.seq, message: { id: clip(id, 240), role, time, parts: parts.slice(0, 200) } })
  }
  return { messages: entries.slice(-MAX_MESSAGES).map(entry => entry.message), truncated: entries.length > MAX_MESSAGES }
}
