import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { CandidateQuery, HostObservation } from '../shared/commands.js'
import type { HostArchive } from '../shared/model.js'
import type { SourceReplay } from './event-model.js'
import type { TranscriptMessage } from '../shared/transcript.js'
export interface HostCandidate { sessionId: string; title: string; workspace: string | null; activityAt: number | null; hostArchive?: HostArchive }
/** A capture is usable only while its exact host objects, journal cursor and execution state still match. */
export interface HostCapture { observation: HostObservation; source?: SourceReplay; validate(): boolean; dispose(): void }
export interface HostTranscript { messages: TranscriptMessage[]; truncated: boolean }
/** Cheap, read-only cache probe: no log open/read. `headerDigest`/`revision`
 *  bind a cold checkpoint to the exact stored lifecycle; `inherited` is null
 *  when the stored header belongs to a seeded/forked session whose cut the
 *  metadata alone cannot prove. */
export interface HostProbe { live: boolean; headerDigest?: string; inherited?: number | null; revision?: string; sizeBytes?: number | null; eventCount?: number | null; hostArchive: HostArchive }
/** One bounded read of the durable source log. `total` is the durable event
 *  count observed with this slice when the backend can report it cheaply. */
export interface HostSourceSlice {
  header: SessionHeader
  inherited: number
  persistenceIdentity: string
  revision: string
  total: number | null
  /** Archive facts observed with this slice, so a managed source keeps the same
   *  archive binding a direct capture would attach. */
  archiveVersion: { sourceId: string; revision: number }
  events: readonly SessionEvent[]
}
export interface HostPort {
  capture(sessionId: string, includeReplay?: boolean, freshReplay?: boolean): Promise<HostCapture>
  /** Optional bounded durable read used by the background baseline fold. */
  readSourceSlice?(sessionId: string, fromCursor: number, maxEvents: number): Promise<HostSourceSlice>
  /** Optional cheap probe used to validate a persisted cold checkpoint. */
  probe?(sessionId: string): Promise<HostProbe>
  list(query: CandidateQuery, membership?: ReadonlySet<string>): Promise<{ items: HostCandidate[]; total: number; nextOffset: number | null; generation?: string }>
  /** Bounded, display-oriented conversation for a read-only preview. Never resumes or prompts. */
  transcript(sessionId: string): Promise<HostTranscript>
  subscribe(listener: (sessionId: string) => void): () => void
  close(): void
}
