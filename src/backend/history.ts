import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { historyQuerySchema, historyRecordSchema, HISTORY_MEMBER_CAPACITY, HISTORY_STORE_CAPACITY, type HistoryRecord, type HistoryQuery, type HistoryPage } from '../shared/history.js'
import type { Board, Card } from '../shared/model.js'
import { fail } from '../shared/commands.js'
import { digestCommand } from './store.js'
import { statusSnapshot } from './workflow.js'

/** Business records never depend on the rolling extension-event feed. */
export class BusinessHistory {
  constructor(private readonly db: DatabaseSync) {}
  create(): void {
    this.db.exec('CREATE TABLE business_history (seq INTEGER PRIMARY KEY, member_id TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL); CREATE INDEX business_history_member ON business_history(member_id, seq); CREATE TABLE history_meta (id INTEGER PRIMARY KEY CHECK(id=1), high_watermark INTEGER NOT NULL); INSERT INTO history_meta VALUES (1, 0); CREATE TABLE history_members (member_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, high_watermark INTEGER NOT NULL, pruned_through INTEGER NOT NULL);')
  }
  private counter(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('STORAGE', 'Invalid business-history watermark'); return value }
  private member(card: Pick<Card, 'membershipId' | 'sessionId'>): void {
    this.db.prepare('INSERT OR IGNORE INTO history_members VALUES (?, ?, 0, 0)').run(card.membershipId, card.sessionId)
    if (this.db.prepare('SELECT session_id FROM history_members WHERE member_id=?').get(card.membershipId)?.session_id !== card.sessionId) fail('STORAGE', 'Business-history membership belongs to a different session')
  }
  validate(): void {
    const high = this.counter(this.db.prepare('SELECT high_watermark FROM history_meta WHERE id=1').get()?.high_watermark)
    const count = this.counter(this.db.prepare('SELECT COUNT(*) AS count FROM business_history').get()?.count)
    if (count > HISTORY_STORE_CAPACITY) fail('STORAGE', 'Business-history capacity metadata is inconsistent')
    const members = new Map<string, { sessionId: string; high: number; pruned: number; count: number; maximum: number }>()
    for (const row of this.db.prepare('SELECT * FROM history_members').all()) {
      const memberHigh = this.counter(row.high_watermark), pruned = this.counter(row.pruned_through)
      if (typeof row.member_id !== 'string' || typeof row.session_id !== 'string' || memberHigh > high || pruned > memberHigh) fail('STORAGE', 'Business-history member watermark is invalid')
      members.set(row.member_id, { sessionId: row.session_id, high: memberHigh, pruned, count: 0, maximum: 0 })
    }
    for (const row of this.db.prepare('SELECT seq, member_id, payload, digest FROM business_history ORDER BY seq').iterate()) {
      const record = this.decode(row)
      const member = members.get(record.membershipId)
      if (!member || member.sessionId !== record.sessionId || record.sequence <= member.pruned || record.sequence > member.high) fail('STORAGE', 'Business-history row does not match its member watermark')
      member.count += 1; member.maximum = record.sequence
    }
    let maximum = 0
    for (const member of members.values()) {
      maximum = Math.max(maximum, member.high)
      if (member.count > HISTORY_MEMBER_CAPACITY || member.maximum !== member.high && member.pruned !== member.high) fail('STORAGE', 'Business-history retained range is inconsistent')
    }
    if (maximum !== high) fail('STORAGE', 'Business-history global watermark does not match member history')
  }
  private decode(row: Record<string, unknown>): HistoryRecord {
    if (typeof row.payload !== 'string' || row.digest !== digestCommand(row.payload)) fail('STORAGE', 'Business-history integrity check failed')
    const raw: unknown = JSON.parse(row.payload), record = historyRecordSchema.parse(raw)
    const session = this.db.prepare('SELECT session_id FROM history_members WHERE member_id=?').get(record.membershipId)?.session_id
    if (!isDeepStrictEqual(raw, record) || record.sequence !== row.seq || record.membershipId !== row.member_id || record.sessionId !== session) fail('STORAGE', 'Business-history identity or canonical data is invalid')
    return record
  }
  append(record: Omit<HistoryRecord, 'schemaVersion' | 'id' | 'sequence'>): void {
    this.member(record)
    const sequence = this.counter(this.db.prepare('SELECT high_watermark FROM history_meta WHERE id=1').get()?.high_watermark) + 1
    const value = historyRecordSchema.parse({ ...record, schemaVersion: 1, id: randomUUID(), sequence })
    const payload = JSON.stringify(value)
    this.db.prepare('INSERT INTO business_history VALUES (?, ?, ?, ?)').run(sequence, value.membershipId, payload, digestCommand(payload))
    this.db.prepare('UPDATE history_meta SET high_watermark=? WHERE id=1').run(sequence)
    this.db.prepare('UPDATE history_members SET high_watermark=? WHERE member_id=?').run(sequence, value.membershipId)
    const cutoff = this.db.prepare('SELECT seq FROM business_history WHERE member_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(value.membershipId, HISTORY_MEMBER_CAPACITY)?.seq
    if (typeof cutoff === 'number') this.prune('member_id=? AND seq<=?', [value.membershipId, cutoff])
    const global = this.db.prepare('SELECT seq FROM business_history ORDER BY seq DESC LIMIT 1 OFFSET ?').get(HISTORY_STORE_CAPACITY)?.seq
    if (typeof global === 'number') this.prune('seq<=?', [global])
  }
  private prune(where: string, params: (string | number)[]): void {
    for (const row of this.db.prepare(`SELECT seq, member_id, payload, digest FROM business_history WHERE ${where}`).all(...params)) {
      this.decode(row)
    }
    const rows = this.db.prepare(`SELECT member_id, MAX(seq) AS cutoff FROM business_history WHERE ${where} GROUP BY member_id`).all(...params)
    for (const row of rows) if (typeof row.member_id === 'string') this.db.prepare('UPDATE history_members SET pruned_through=MAX(pruned_through, ?) WHERE member_id=?').run(this.counter(row.cutoff), row.member_id)
    this.db.prepare(`DELETE FROM business_history WHERE ${where}`).run(...params)
  }
  changes(before: Board, after: Board, at: number, requestId: string | null): void {
    for (const card of after.cards) {
      this.member(card)
      const old = before.cards.find(row => row.membershipId === card.membershipId)
      if (!old) continue // Joining never invents pre-membership execution/history.
      const base = { sessionId: card.sessionId, membershipId: card.membershipId, at, episodeId: card.runtime.episodeId, origin: card.origin, fromProjectId: old.projectId, toProjectId: card.projectId, from: old.placement, to: card.placement, decision: card.decision, requestId,
        fromState: old.placement.kind === 'custom' ? statusSnapshot(before, old.placement.statusId) : old.origin?.kind === 'state' ? old.origin.state : null,
        toState: card.placement.kind === 'custom' ? statusSnapshot(after, card.placement.statusId) : card.origin?.kind === 'state' ? card.origin.state : null,
        fromProject: old.projectId === null ? null : this.projectSnapshot(before, old.projectId), toProject: card.projectId === null ? null : this.projectSnapshot(after, card.projectId) }
      if (old.runtime.episodeId !== card.runtime.episodeId && card.runtime.episodeId !== null) this.append({ ...base, kind: 'episode_started', requestId: null })
      if (old.projectId !== card.projectId) this.append({ ...base, kind: 'project_moved' })
      if (card.decision && JSON.stringify(old.decision) !== JSON.stringify(card.decision)) {
        this.append({ ...base, kind: card.decision.kind === 'accepted' ? 'accepted' : card.decision.kind === 'returned' ? 'returned' : card.decision.kind === 'reopened' ? 'reopened' : 'legacy_decision', at: card.decision.at })
      } else if (requestId && old.projectId === card.projectId && JSON.stringify(old.placement) !== JSON.stringify(card.placement)) this.append({ ...base, kind: 'state_changed' })
    }
  }
  private projectSnapshot(board: Board, id: string): { projectId: string; projectName: string; projectRevision: number } | null { const project = board.projects.find(row => row.id === id); return project ? { projectId: project.id, projectName: project.name, projectRevision: project.revision } : null }
  page(raw: HistoryQuery): HistoryPage {
    const query = historyQuerySchema.parse(raw)
    const member = this.db.prepare('SELECT * FROM history_members WHERE member_id=?').get(query.membershipId)
    if (!member || member.session_id !== query.sessionId) fail('NOT_FOUND', 'Business history does not belong to this session membership')
    const highWatermark = this.counter(member.high_watermark), pruned = this.counter(member.pruned_through)
    const first = this.db.prepare('SELECT MIN(seq) AS first FROM business_history WHERE member_id=?').get(query.membershipId)?.first
    const retainedFrom = typeof first === 'number' ? first : highWatermark + 1
    const after = query.after ?? pruned, gap = query.after !== undefined && (query.after < pruned || query.after > highWatermark)
    const rows = gap ? [] : this.db.prepare('SELECT seq, member_id, payload, digest FROM business_history WHERE member_id=? AND seq>? ORDER BY seq LIMIT ?').all(query.membershipId, after, query.limit + 1)
    const records = rows.slice(0, query.limit).map(row => {
      const value = this.decode(row)
      if (value.membershipId !== query.membershipId || value.sessionId !== query.sessionId) fail('STORAGE', 'Business-history page belongs to a different member')
      return value
    })
    return { sessionId: query.sessionId, membershipId: query.membershipId, records, nextAfter: rows.length > query.limit ? records.at(-1)?.sequence ?? null : null, retainedFrom, highWatermark, truncated: pruned > 0, gap }
  }
}
