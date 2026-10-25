import { z } from 'zod'

const id = z.string().min(1).max(240)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** One read-only, already-normalized piece of a session conversation. The preview never
 *  exposes raw provider or tool payloads beyond these bounded display strings. */
export const transcriptPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(20000) }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string().max(8000) }).strict(),
  z.object({ type: z.literal('tool-call'), name: z.string().max(200), arguments: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('tool-result'), name: z.string().max(200).nullable(), text: z.string().max(12000), isError: z.boolean() }).strict(),
  z.object({ type: z.literal('attachment'), kind: z.enum(['image', 'file']), name: z.string().max(500).nullable() }).strict(),
])
export const transcriptMessageSchema = z.object({
  id: z.string().max(240),
  role: z.enum(['user', 'assistant', 'tool']),
  time: counter,
  parts: z.array(transcriptPartSchema).max(200),
}).strict()
export const transcriptQuerySchema = z.object({ sessionId: id }).strict()
export const transcriptSchema = z.object({
  sessionId: id,
  title: z.string().max(1000),
  messages: z.array(transcriptMessageSchema).max(200),
  /** True when older messages were omitted from this preview. */
  truncated: z.boolean(),
  coverage: z.enum(['complete', 'partial']),
  reason: z.string().max(1000).nullable(),
}).strict()

export type TranscriptPart = z.infer<typeof transcriptPartSchema>
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>
