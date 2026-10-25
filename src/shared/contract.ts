import type { InvocationDescriptor, RemoteResult, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE, snapshotSchema, type Snapshot } from './model.js'
import { candidateQuerySchema, candidatesPageSchema, inspectionQuerySchema, sessionInspectionSchema, mutationSchema, navigationQuerySchema, navigationResultSchema, type InspectionQuery, type SessionInspection, type NavigationQuery, type NavigationResult, type CandidatePage, type CandidateQuery, type Mutation, type DomainErrorCode, type ErrorParameters } from './commands.js'
import { historyPageSchema, historyQuerySchema, type HistoryPage, type HistoryQuery } from './history.js'
import { transcriptQuerySchema, transcriptSchema, type Transcript, type TranscriptQuery } from './transcript.js'
import { eventPageSchema, eventQuerySchema, handshakeSchema, publicQuerySchema, publicSnapshotSchema, type DashboardHandshake, type PublicQuery, type EventQuery, type PublicSnapshot, type EventPage } from './extension.js'

export interface DashboardRemote {
  handshake(): Promise<RemoteResult<DashboardHandshake>>
  extensionSnapshot(query: PublicQuery): Promise<RemoteResult<PublicSnapshot>>
  extensionEvents(query: EventQuery): Promise<RemoteResult<EventPage>>
  navigation(query: NavigationQuery): Promise<RemoteResult<NavigationResult>>
  snapshot(): Promise<RemoteResult<Snapshot>>
  candidates(query: CandidateQuery): Promise<RemoteResult<CandidatePage>>
  inspectSession(query: InspectionQuery): Promise<RemoteResult<SessionInspection>>
  history(query: HistoryQuery): Promise<RemoteResult<HistoryPage>>
  transcript(query: TranscriptQuery): Promise<RemoteResult<Transcript>>
  mutate(mutation: Mutation): Promise<RemoteResult<Snapshot>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { sessionDashboard: DashboardRemote }
  interface RemoteErrorDetailsMap { 'dashboard/error': { reason: DomainErrorCode; messageKey?: string; params?: ErrorParameters } }
}
const codec = (name: string, schema: { parse(value: unknown): unknown }): TypertCodec => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => schema })
const snapshot = codec('Snapshot', snapshotSchema)
export const descriptors: InvocationDescriptor[] = [
  { id: `${PACKAGE}#sessionDashboard/handshake`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'handshake', invocation: { kind: 'direct' }, parameters: [], result: codec('Handshake', handshakeSchema) },
  { id: `${PACKAGE}#sessionDashboard/extensionSnapshot`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'extensionSnapshot', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('PublicQuery', publicQuerySchema) }], result: codec('PublicSnapshot', publicSnapshotSchema) },
  { id: `${PACKAGE}#sessionDashboard/extensionEvents`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'extensionEvents', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('EventQuery', eventQuerySchema) }], result: codec('EventPage', eventPageSchema) },
  { id: `${PACKAGE}#sessionDashboard/navigation`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'navigation', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('NavigationQuery', navigationQuerySchema) }], result: codec('NavigationResult', navigationResultSchema) },
  { id: `${PACKAGE}#sessionDashboard/snapshot`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'snapshot', invocation: { kind: 'direct' }, parameters: [], result: snapshot },
  { id: `${PACKAGE}#sessionDashboard/candidates`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'candidates', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('CandidateQuery', candidateQuerySchema) }], result: codec('CandidatePage', candidatesPageSchema) },
  { id: `${PACKAGE}#sessionDashboard/inspectSession`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'inspectSession', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('InspectionQuery', inspectionQuerySchema) }], result: codec('SessionInspection', sessionInspectionSchema) },
  { id: `${PACKAGE}#sessionDashboard/history`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'history', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('HistoryQuery', historyQuerySchema) }], result: codec('HistoryPage', historyPageSchema) },
  { id: `${PACKAGE}#sessionDashboard/transcript`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'transcript', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('TranscriptQuery', transcriptQuerySchema) }], result: codec('Transcript', transcriptSchema) },
  { id: `${PACKAGE}#sessionDashboard/mutate`, service: 'sessionDashboard', namespace: 'sessionDashboard', method: 'mutate', invocation: { kind: 'direct' }, parameters: [{ name: 'mutation', wire: 'mutation', source: 'json', codec: codec('Mutation', mutationSchema) }], result: snapshot },
]
export const remote = { package: PACKAGE, descriptors }
export default remote
