import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { BOARD_SCHEMA_VERSION, emptyBoard, toStoredBoard, upgradeBoardPayload, type Board, type Card } from '../shared/model.js'
import { domainEventSchema, scopeSchema, type CardSummary, type DashboardScope, type DomainEvent } from '../shared/extension.js'
import { DashboardError, errorText, fail, observationSchema, type HostObservation } from '../shared/commands.js'
import { parseBoard, parseStoredBoard } from './invariants.js'
import { BusinessHistory } from './history.js'
import type { HistoryQuery, HistoryPage } from '../shared/history.js'
import { boardEvents, sourcePrefixDigest, summarize, type CompletionEvidence, type PendingEvent, type SourceReplay } from './event-model.js'
import type { LifecycleJournalState } from './lifecycle.js'

export interface Receipt { requestId: string; digest: string }
export interface CommitResult { board: Board; duplicate: boolean }
export interface StoreSnapshot { board: Board; scope: DashboardScope; highWatermark: number; retainedFrom: number; cards: CardSummary[] }
export interface StoreEvents { scope: DashboardScope; highWatermark: number; retainedFrom: number; nextCursor: number; events: DomainEvent[]; gap: boolean }
/** A revision-keyed cold observation. It is a fold shortcut, never evidence: a
 *  mismatch or unreadable row falls back to a durable log read. */
export interface ColdCheckpoint { sessionId: string; headerDigest: string; inherited: number | null; revision: string; sizeBytes: number | null; observation: HostObservation; updatedAt: number }
/** A resumable incremental source fold, keyed by the session and its durable
 *  persistence identity. `journal` is the small LifecycleJournal checkpoint;
 *  `prefixDigest` is the hash at `cursor`, not the full prefix array. */
export interface SourceFoldCheckpoint {
  sessionId: string
  persistenceIdentity: string
  headerDigest: string
  inherited: number
  revision: string
  cursor: number
  sourceIdentity: string
  legacySourceIdentity: string
  fromCursor: number
  fromDigest: string
  prefixDigest: string
  /** Older checkpoint cuts, bounded; the current cut is `prefixDigest`. */
  history: readonly { cursor: number; digest: string }[]
  journal: LifecycleJournalState
  completions: readonly CompletionEvidence[]
  updatedAt: number
}
export interface BoardStore {
  read(): Board
  identity(): DashboardScope
  sourceEligible(membershipId: string, source: SourceReplay): boolean
  snapshot(): StoreSnapshot
  events(after: number, limit: number): StoreEvents
  history(query: HistoryQuery): HistoryPage
  subscribe(listener: () => void): () => void
  wasCommitted(receipt: Receipt): boolean
  coldCheckpoint(sessionId: string): ColdCheckpoint | null
  saveColdCheckpoint(checkpoint: ColdCheckpoint): void
  deleteColdCheckpoint(sessionId: string): void
  sourceFold(sessionId: string): SourceFoldCheckpoint | null
  saveSourceFold(checkpoint: SourceFoldCheckpoint): void
  deleteSourceFold(sessionId: string): void
  commit(receipt: Receipt | null, change: (board: Board) => boolean, fence?: () => void, sources?: readonly SourceReplay[], rebaseline?: ReadonlySet<string>): CommitResult
  close(): void
}
export const digestCommand = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const replayLegacyIdentities = (replay: SourceReplay): readonly string[] => {
  const values = replay.legacySourceIdentities ?? (replay.legacySourceIdentity === undefined ? [] : [replay.legacySourceIdentity])
  return values
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metaSchema = z.object({ scope: scopeSchema, binding: z.string().min(1), highWatermark: integer, retainedFrom: integer }).strict()
const sourceSchema = z.object({ identity: z.string().min(1).max(128), cursor: integer, digest: z.string().length(64), coverage: z.enum(['complete', 'unavailable']), baselineEstablished: z.boolean(), requiresRebaseline: z.boolean(), rebaselineKind: z.enum(['identity', 'prefix']).nullable().optional(), evidence: z.object({ episodeId: z.string(), digest: z.string().length(64) }).strict().nullable(), archiveVersion: z.object({ sourceId: z.string(), revision: integer }).strict().nullable(), reason: z.string().max(1000).nullable() }).strict()
type Meta = z.infer<typeof metaSchema>
type SourceState = z.infer<typeof sourceSchema>
// A slow/uninstalled consumer cannot pin the core queue. Expired cursors report an explicit gap.
export const EVENT_CAPACITY = 50000
export const EVENT_RETENTION_MS = 30 * 86400000
const MEMBER_CAPACITY = 100000
/** A parsed board keyed by the exact durable row it was decoded from. A hit needs
 *  the stored revision, payload AND digest to be unchanged, so skipping the SHA-256
 *  and zod pass never weakens tamper detection: any changed byte (or any other
 *  connection's write) misses the cache and forces a full integrity re-check. */
interface BoardCacheEntry { revision: number; payload: string; digest: string; board: Board }
interface MetaCacheEntry { payload: string; digest: string; meta: Meta }

/** The schema this build writes, and the one it upgrades in place. */
const SCHEMA_VERSION = BOARD_SCHEMA_VERSION
const SCHEMA_VERSION_V8 = 8
const SCHEMA_VERSION_V9 = 9
const SCHEMA_VERSION_V10 = 10

/** The board, source watermarks, semantic events and idempotent receipts share one durable
 * transaction. Extension callbacks run only AFTER COMMIT, never inside the authority fence. */
/** Read one persisted event, tolerating summaries written before the priority
 *  dimension was removed (schema 8). The stored payload keeps its digest; only the
 *  decoded view drops the retired key, so old evidence stays verifiable. */
export function parseStoredDomainEvent(payload: string): DomainEvent {
  const raw: unknown = JSON.parse(payload)
  if (typeof raw === 'object' && raw !== null && 'summary' in raw) {
    const summary = (raw as { summary?: unknown }).summary
    if (typeof summary === 'object' && summary !== null && 'priorityId' in summary) delete (summary as Record<string, unknown>).priorityId
  }
  return domainEventSchema.parse(raw)
}

export class SqliteBoardStore implements BoardStore {
  private readonly db: DatabaseSync
  private readonly businessHistory: BusinessHistory
  private closed = false
  private boardCache: BoardCacheEntry | null = null
  private metaCache: MetaCacheEntry | null = null
  private readonly listeners = new Set<() => void>()
  constructor(path: string, binding?: string, private readonly now: () => number = Date.now) {
    const owner = binding ?? (path === ':memory:' ? 'isolated-memory' : `isolated-path:${resolve(path)}`)
    if (path !== ':memory:') {
      const absolute = resolve(path)
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
      this.db = new DatabaseSync(absolute)
      // POSIX modes do not map to Windows ACLs; the profile directory still
      // carries the platform's own protection there.
      if (process.platform !== 'win32') chmodSync(absolute, 0o600)
    } else this.db = new DatabaseSync(':memory:')
    this.businessHistory = new BusinessHistory(this.db)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const check = this.db.prepare('PRAGMA quick_check').get()
      if (!check || check.quick_check !== 'ok') fail('STORAGE', '仪表板数据库校验失败；保留原文件并从备份恢复')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version
        // Only a brand-new file and the last three schemas are accepted: the v1-v7
        // migration chain was removed, so an older file must be opened once with a
        // build up to 0.6.7 before this version can read it. v8 and v9 are upgraded
        // in place (the payload becomes tag-only and the write-only columns go), so
        // an existing board keeps loading without manual steps.
        if (version !== 0 && version !== SCHEMA_VERSION_V8 && version !== SCHEMA_VERSION_V9 && version !== SCHEMA_VERSION_V10 && version !== SCHEMA_VERSION) fail('STORAGE', `不支持的仪表板数据库版本 ${String(version)}；低于 8 的旧库请先用 0.6.7 或更早版本打开升级，再升级到本版本`)
        if (version === SCHEMA_VERSION_V8 || version === SCHEMA_VERSION_V9 || version === SCHEMA_VERSION_V10) this.migrateToCurrent(version)
        if (version === 0) {
          const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
          if (tables.length) fail('STORAGE', '未识别的数据库结构；拒绝初始化覆盖')
          this.db.exec('CREATE TABLE board (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), payload TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL);')
          this.db.exec('CREATE TABLE dashboard_meta (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE domain_events (seq INTEGER PRIMARY KEY, committed_at INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE memberships (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, source TEXT, source_digest TEXT);')
          const board = emptyBoard(), payload = JSON.stringify(toStoredBoard(board))
          this.db.prepare('INSERT INTO board VALUES (1, ?, ?, ?)').run(board.revision, payload, digestCommand(payload))
          const meta: Meta = { scope: { scopeId: randomUUID(), storeId: randomUUID(), recoveryId: randomUUID() }, binding: owner, highWatermark: 0, retainedFrom: 1 }
          const metaPayload = JSON.stringify(meta)
          this.db.prepare('INSERT INTO dashboard_meta VALUES (1, ?, ?)').run(metaPayload, digestCommand(metaPayload))
          for (const card of this.load().cards) this.db.prepare('INSERT INTO memberships (id, generation, source, source_digest) VALUES (?, 0, NULL, NULL)').run(card.membershipId)
          this.businessHistory.create()
          this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
        }
        this.db.exec('CREATE TABLE IF NOT EXISTS session_checkpoints (session_id TEXT PRIMARY KEY, header_digest TEXT NOT NULL, inherited INTEGER, revision TEXT NOT NULL, size_bytes INTEGER, observation TEXT NOT NULL, updated_at INTEGER NOT NULL)')
        this.db.exec('CREATE TABLE IF NOT EXISTS source_folds (session_id TEXT PRIMARY KEY, persistence_id TEXT NOT NULL, header_digest TEXT NOT NULL, inherited INTEGER NOT NULL, revision TEXT NOT NULL, cursor INTEGER NOT NULL, source_identity TEXT NOT NULL, legacy_source_identity TEXT NOT NULL, from_cursor INTEGER NOT NULL, from_digest TEXT NOT NULL, prefix_digest TEXT NOT NULL, history TEXT NOT NULL DEFAULT \'[]\', journal TEXT NOT NULL, completions TEXT NOT NULL, updated_at INTEGER NOT NULL)')
        if (!this.db.prepare('PRAGMA table_info(source_folds)').all().some(row => row.name === 'history')) this.db.exec("ALTER TABLE source_folds ADD COLUMN history TEXT NOT NULL DEFAULT '[]'")
        if (this.meta().binding !== owner) fail('FORBIDDEN', '此数据库已绑定另一个 profile / 数据范围，拒绝跨范围复用；请使用独立 dataDir')
        this.load(); this.businessHistory.validate(); this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) { this.db.close(); throw error }
  }
  /** v8/v9 -> v11 and v10 -> v11: v8/v9 stored the runtime shape (projects,
   *  card.projectId, the removed tab/board views), while v10 already stored the
   *  tag-only durable form. Each shape is validated by its own parser, so a v10
   *  database never round-trips through the runtime projection; the rewritten
   *  payload is re-digested in the same transaction and history, events and
   *  receipts keep their rows.
   */
  private migrateToCurrent(_version: number): void {
    const row = this.db.prepare('SELECT revision, payload FROM board WHERE id=1').get()
    if (!row || typeof row.payload !== 'string' || typeof row.revision !== 'number') fail('STORAGE', '仪表板数据库缺少看板数据，无法升级')
    let raw: unknown
    try { raw = JSON.parse(row.payload) } catch { fail('STORAGE', '仪表板看板数据无法解析，拒绝升级') }
    // upgradeBoardPayload adds the missing tag-group order (v9/v10) and the current
    // marker; only the shape it starts from differs.
    const candidate = upgradeBoardPayload(raw)
    const durable = typeof candidate === 'object' && candidate !== null && !('projects' in candidate)
    if (durable) parseStoredBoard(candidate) // v10 is already the tag-only form: validate it, never project it back
    const payload = durable
      ? JSON.stringify(candidate)
      : JSON.stringify(toStoredBoard(parseBoard(candidate)))
    this.db.prepare('UPDATE board SET payload=?, digest=? WHERE id=1').run(payload, digestCommand(payload))
    // SQLite drops a column only when nothing indexes or constrains it; both of these
    // are plain columns, and the guard keeps a re-run harmless.
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]).map(row => String(row.name)))
    if (columns('receipts').has('committed_revision')) this.db.exec('ALTER TABLE receipts DROP COLUMN committed_revision')
    if (columns('memberships').has('session_id')) this.db.exec('ALTER TABLE memberships DROP COLUMN session_id')
    this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
  }

  private available(): void { if (this.closed) fail('CLOSED', '仪表板存储已关闭') }
  /** Reads the durable row and returns the cached decode only when the row still
   *  matches it byte-for-byte. A miss (including every first read) recomputes the
   *  digest before anything is parsed, so a tampered payload with the old digest is
   *  rejected exactly as before the cache existed. */
  private rawBoard(): { payload: string; revision: number; digest: string; board: Board | null } {
    const row = this.db.prepare('SELECT revision, payload, digest FROM board WHERE id=1').get()
    if (!row || typeof row.payload !== 'string' || typeof row.digest !== 'string' || typeof row.revision !== 'number') fail('STORAGE', '仪表板数据完整性校验失败；拒绝自动修复或清空')
    const cached = this.boardCache
    if (cached && cached.revision === row.revision && cached.payload === row.payload && cached.digest === row.digest)
      return { payload: row.payload, revision: row.revision, digest: row.digest, board: cached.board }
    if (digestCommand(row.payload) !== row.digest) fail('STORAGE', '仪表板数据完整性校验失败；拒绝自动修复或清空')
    return { payload: row.payload, revision: row.revision, digest: row.digest, board: null }
  }
  /** The cached decode is shared by internal readers (commit compares against it and
   *  never mutates it); public results are cloned at the boundary. */
  private load(): Board {
    const row = this.rawBoard()
    if (row.board) return row.board
    const board = parseStoredBoard(JSON.parse(row.payload) as unknown)
    if (board.revision !== row.revision) fail('STORAGE', '仪表板数据版本不一致')
    this.boardCache = { revision: row.revision, payload: row.payload, digest: row.digest, board }
    return board
  }
  /** Callers may mutate the returned scope, so the small meta record is cloned per
   *  read while its digest, JSON.decode and zod validation stay cached. */
  private meta(): Meta {
    const row = this.db.prepare('SELECT payload, digest FROM dashboard_meta WHERE id=1').get()
    if (!row || typeof row.payload !== 'string' || typeof row.digest !== 'string') fail('STORAGE', '仪表板范围记录校验失败')
    const cached = this.metaCache
    if (cached && cached.payload === row.payload && cached.digest === row.digest) return structuredClone(cached.meta)
    if (digestCommand(row.payload) !== row.digest) fail('STORAGE', '仪表板范围记录校验失败')
    const meta = metaSchema.parse(JSON.parse(row.payload) as unknown)
    this.metaCache = { payload: row.payload, digest: row.digest, meta }
    return structuredClone(meta)
  }
  /** Writes the row inside the caller's transaction. The returned cache entry is
   *  installed only after COMMIT, so a rollback cannot publish uncommitted meta. */
  private saveMeta(meta: Meta): { payload: string; digest: string } {
    const payload = JSON.stringify(meta), digest = digestCommand(payload)
    this.db.prepare('UPDATE dashboard_meta SET payload=?, digest=? WHERE id=1').run(payload, digest)
    return { payload, digest }
  }
  private source(id: string): SourceState | null {
    const row = this.db.prepare('SELECT source, source_digest FROM memberships WHERE id=?').get(id)
    if (!row || row.source === null) return null
    if (typeof row.source !== 'string' || digestCommand(row.source) !== row.source_digest) fail('STORAGE', '会话来源游标校验失败')
    return sourceSchema.parse(JSON.parse(row.source) as unknown)
  }
  coldCheckpoint(sessionId: string): ColdCheckpoint | null {
    this.available()
    const row = this.db.prepare('SELECT header_digest, inherited, revision, size_bytes, observation, updated_at FROM session_checkpoints WHERE session_id=?').get(sessionId)
    if (!row) return null
    try {
      return { sessionId, headerDigest: String(row.header_digest), inherited: typeof row.inherited === 'number' ? row.inherited : null,
        revision: String(row.revision), sizeBytes: typeof row.size_bytes === 'number' ? row.size_bytes : null,
        observation: observationSchema.parse(JSON.parse(String(row.observation))), updatedAt: Number(row.updated_at) }
    } catch { this.db.prepare('DELETE FROM session_checkpoints WHERE session_id=?').run(sessionId); return null }
  }
  saveColdCheckpoint(checkpoint: ColdCheckpoint): void {
    this.available()
    const observation = observationSchema.parse(checkpoint.observation)
    this.db.prepare('INSERT INTO session_checkpoints(session_id, header_digest, inherited, revision, size_bytes, observation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET header_digest=excluded.header_digest, inherited=excluded.inherited, revision=excluded.revision, size_bytes=excluded.size_bytes, observation=excluded.observation, updated_at=excluded.updated_at')
      .run(checkpoint.sessionId, checkpoint.headerDigest, checkpoint.inherited, checkpoint.revision, checkpoint.sizeBytes, JSON.stringify(observation), checkpoint.updatedAt)
  }
  deleteColdCheckpoint(sessionId: string): void { this.available(); this.db.prepare('DELETE FROM session_checkpoints WHERE session_id=?').run(sessionId) }
  sourceFold(sessionId: string): SourceFoldCheckpoint | null {
    this.available()
    const row = this.db.prepare('SELECT persistence_id, header_digest, inherited, revision, cursor, source_identity, legacy_source_identity, from_cursor, from_digest, prefix_digest, history, journal, completions, updated_at FROM source_folds WHERE session_id=?').get(sessionId)
    if (!row) return null
    try {
      const journal = JSON.parse(String(row.journal)) as LifecycleJournalState
      const completions = JSON.parse(String(row.completions)) as CompletionEvidence[]
      const history = JSON.parse(String(row.history)) as { cursor: number; digest: string }[]
      if (journal.version !== 1 || !Array.isArray(completions) || !Array.isArray(history)) throw new Error('invalid fold checkpoint')
      return {
        sessionId, persistenceIdentity: String(row.persistence_id), headerDigest: String(row.header_digest), inherited: Number(row.inherited),
        revision: String(row.revision), cursor: Number(row.cursor), sourceIdentity: String(row.source_identity),
        legacySourceIdentity: String(row.legacy_source_identity), fromCursor: Number(row.from_cursor), fromDigest: String(row.from_digest), prefixDigest: String(row.prefix_digest),
        history, journal, completions, updatedAt: Number(row.updated_at),
      }
    } catch { this.db.prepare('DELETE FROM source_folds WHERE session_id=?').run(sessionId); return null }
  }
  saveSourceFold(checkpoint: SourceFoldCheckpoint): void {
    this.available()
    if (checkpoint.journal.version !== 1 || !Array.isArray(checkpoint.completions) || !Array.isArray(checkpoint.history)) fail('STORAGE', '来源 fold checkpoint 无效')
    this.db.prepare('INSERT INTO source_folds(session_id, persistence_id, header_digest, inherited, revision, cursor, source_identity, legacy_source_identity, from_cursor, from_digest, prefix_digest, history, journal, completions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET persistence_id=excluded.persistence_id, header_digest=excluded.header_digest, inherited=excluded.inherited, revision=excluded.revision, cursor=excluded.cursor, source_identity=excluded.source_identity, legacy_source_identity=excluded.legacy_source_identity, from_cursor=excluded.from_cursor, from_digest=excluded.from_digest, prefix_digest=excluded.prefix_digest, history=excluded.history, journal=excluded.journal, completions=excluded.completions, updated_at=excluded.updated_at')
      .run(checkpoint.sessionId, checkpoint.persistenceIdentity, checkpoint.headerDigest, checkpoint.inherited, checkpoint.revision, checkpoint.cursor, checkpoint.sourceIdentity, checkpoint.legacySourceIdentity, checkpoint.fromCursor, checkpoint.fromDigest, checkpoint.prefixDigest, JSON.stringify(checkpoint.history), JSON.stringify(checkpoint.journal), JSON.stringify(checkpoint.completions), checkpoint.updatedAt)
  }
  deleteSourceFold(sessionId: string): void { this.available(); this.db.prepare('DELETE FROM source_folds WHERE session_id=?').run(sessionId) }
  sourceEligible(membershipId: string, replay: SourceReplay): boolean {
    this.available()
    if (replay.coverage !== 'complete' || sourcePrefixDigest(replay, replay.throughCursor) === null) return false
    const old = this.source(membershipId)
    if (!old?.baselineEstablished) return true
    const atOld = sourcePrefixDigest(replay, old.cursor)
    const exact = old.identity === replay.sourceIdentity && old.cursor <= replay.throughCursor && atOld === old.digest
    const legacyCompatible = replayLegacyIdentities(replay).includes(old.identity) && old.cursor <= replay.throughCursor
    if (old.requiresRebaseline) return old.rebaselineKind === 'prefix' ? false : exact || legacyCompatible
    if (exact) return true
    // Compatibility: builds before delegationDepth normalization hashed the raw
    // header (depth zero was omitted or materialized in another position). A
    // matching legacy identity is the same durable history, not a reason to
    // freeze human review.
    return legacyCompatible
  }
  private generation(id: string): number {
    const value = this.db.prepare('SELECT generation FROM memberships WHERE id=?').get(id)?.generation
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('STORAGE', '卡片成员代次缺失或无效')
    return value
  }
  private summary(card: Card, board: Board): CardSummary {
    const source = this.source(card.membershipId)
    return { ...summarize(card, this.generation(card.membershipId), board), completionCoverage: source?.coverage ?? 'unavailable', sourceIdentity: source?.identity ?? null, sourceCursor: source?.cursor ?? null, completionEvidenceDigest: source?.coverage === 'complete' && source.evidence?.episodeId === card.runtime.episodeId ? source.evidence.digest : null }
  }
  /** Consumers treat a read board as their own object, so hand out an isolated
   *  clone. It still skips the digest, JSON.decode and zod work that used to run on
   *  every call; structuredClone of the small aggregate is far cheaper than reparsing. */
  read(): Board {
    this.available()
    try { return structuredClone(this.load()) }
    catch (error) { if (error instanceof DashboardError) throw error; fail('STORAGE', `读取仪表板失败：${errorText(error)}`) }
  }
  identity(): DashboardScope { this.available(); return this.meta().scope }
  snapshot(): StoreSnapshot {
    this.available(); this.db.exec('BEGIN')
    try {
      // The caller mutates board projections (ephemeral sync withdrawals), so never
      // expose the cached decode itself; summaries are already fresh per call.
      const board = structuredClone(this.load()), meta = this.meta()
      const result = { board, scope: meta.scope, highWatermark: meta.highWatermark, retainedFrom: meta.retainedFrom, cards: board.cards.map(card => this.summary(card, board)) }
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  events(after: number, limit: number): StoreEvents {
    this.available(); integer.parse(after); z.number().int().min(1).max(200).parse(limit)
    this.db.exec('BEGIN')
    try {
      const meta = this.meta()
      const gap = after < meta.retainedFrom - 1 || after > meta.highWatermark
      const events = gap ? [] : this.db.prepare('SELECT payload, digest FROM domain_events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => {
        if (typeof row.payload !== 'string' || digestCommand(row.payload) !== row.digest) fail('STORAGE', '事件完整性校验失败')
        const event = parseStoredDomainEvent(row.payload)
        if (digestCommand(event.scope) !== digestCommand(meta.scope)) fail('STORAGE', '事件范围不匹配')
        return event
      })
      const result = { scope: meta.scope, highWatermark: meta.highWatermark, retainedFrom: meta.retainedFrom, nextCursor: events.at(-1)?.sequence ?? after, events, gap }
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  history(query: HistoryQuery): HistoryPage {
    this.available(); this.db.exec('BEGIN')
    try { const page = this.businessHistory.page(query); this.db.exec('COMMIT'); return page }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  subscribe(listener: () => void): () => void { this.available(); this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  wasCommitted(receipt: Receipt): boolean {
    this.available()
    try {
      const row = this.db.prepare('SELECT digest FROM receipts WHERE request_id=?').get(receipt.requestId)
      if (!row) return false
      if (row.digest !== receipt.digest) fail('CONFLICT', '同一请求标识不能用于不同操作')
      return true
    } catch (error) { if (error instanceof DashboardError) throw error; fail('STORAGE', `读取操作回执失败：${errorText(error)}`) }
  }
  private recordSource(card: Card, replay: SourceReplay, at: number): PendingEvent[] {
    const old = this.source(card.membershipId)
    const archiveChanged = old?.archiveVersion && replay.archiveVersion && old.archiveVersion.sourceId === replay.archiveVersion.sourceId && replay.archiveVersion.revision > old.archiveVersion.revision
    if (archiveChanged) this.db.prepare('UPDATE memberships SET generation=generation+1 WHERE id=?').run(card.membershipId)
    const valid = replay.coverage === 'complete' && sourcePrefixDigest(replay, replay.throughCursor) !== null
    const atOld = sourcePrefixDigest(replay, old?.cursor ?? -1)
    const exact = Boolean(valid && old?.baselineEstablished && old.identity === replay.sourceIdentity && old.cursor <= replay.throughCursor && atOld === old.digest)
    const legacyCompatible = Boolean(valid && old?.baselineEstablished && replayLegacyIdentities(replay).includes(old.identity) && old.cursor <= replay.throughCursor)
    const compatible = exact || legacyCompatible
    const prefixMismatch = Boolean(old?.baselineEstablished && (!valid || old.cursor > replay.throughCursor || atOld !== old.digest))
    const identityMismatch = Boolean(old?.baselineEstablished && !legacyCompatible && old.identity !== replay.sourceIdentity)
    const stickyPrefix = old?.requiresRebaseline === true && old.rebaselineKind === 'prefix'
    const mismatch = valid && old?.baselineEstablished && !compatible
    const requiresRebaseline = Boolean(stickyPrefix || mismatch)
    const rebaselineKind = requiresRebaseline ? prefixMismatch || old?.rebaselineKind === 'prefix' ? 'prefix' as const : identityMismatch ? 'identity' as const : old?.rebaselineKind ?? null : null
    const gap = !valid || requiresRebaseline
    const reason = gap ? replay.reason ?? old?.reason ?? '来源身份、前缀或完整覆盖发生变化；自动化已暂停，需要显式对账' : null
    const cursor = gap && old ? old.cursor : replay.throughCursor
    const completion = replay.completions.find(row => row.episodeId === card.runtime.episodeId)
    const state: SourceState = { identity: gap && old ? old.identity : replay.sourceIdentity, cursor, digest: gap && old ? old.digest : sourcePrefixDigest(replay, cursor) ?? digestCommand(null), coverage: gap ? 'unavailable' : 'complete', baselineEstablished: old?.baselineEstablished === true || valid, requiresRebaseline, rebaselineKind, archiveVersion: replay.archiveVersion ?? old?.archiveVersion ?? null, evidence: !gap && completion ? { episodeId: completion.episodeId, digest: completion.digest } : null, reason }
    const payload = JSON.stringify(sourceSchema.parse(state))
    // Idle reconciles commonly reach the same source cut. Avoid an unconditional row
    // rewrite (and its WAL/fsync work) when the canonical source state is unchanged.
    const unchanged = old !== null && digestCommand(old) === digestCommand(sourceSchema.parse(JSON.parse(payload) as unknown))
    if (!unchanged) this.db.prepare('UPDATE memberships SET source=?, source_digest=? WHERE id=?').run(payload, digestCommand(payload), card.membershipId)
    const make = (kind: PendingEvent['kind'], episodeId: string | null, sourceCursor: number, occurredAt: number, historical: boolean, evidenceDigest: string | null): PendingEvent => ({ card, sessionId: card.sessionId, membershipId: card.membershipId, kind, episodeId, sourceIdentity: state.identity, sourceCursor, occurredAt, historical, evidenceDigest, reason })
    const invalidated = archiveChanged ? [make('host_archive', card.runtime.episodeId, cursor, at, false, null)] : []
    if (gap) return old?.coverage === 'unavailable' && old.reason === reason ? invalidated : [...invalidated, make('source_gap', card.runtime.episodeId, cursor, at, false, null)]
    // The first source cut is a baseline, not a replay of all pre-install historical completions.
    if (!old?.baselineEstablished) return [...invalidated, make('source_baseline', card.runtime.episodeId, cursor, at, true, state.digest)]
    return [...invalidated, ...replay.completions.filter(completion => completion.cursor > old.cursor && completion.cursor <= cursor).map(completion => make('completed', completion.episodeId, completion.cursor, completion.endedAt, false, completion.digest))]
  }
  commit(receipt: Receipt | null, change: (board: Board) => boolean, fence: () => void = () => {}, sources: readonly SourceReplay[] = [], rebaseline: ReadonlySet<string> = new Set()): CommitResult {
    this.available()
    let transaction = false, notify = false
    let pendingBoard: BoardCacheEntry | null = null, pendingMetaCache: MetaCacheEntry | null = null
    let result: CommitResult
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true
      const before = this.load(), board = structuredClone(before)
      fence()
      if (receipt && this.wasCommitted(receipt)) {
        fence(); this.db.exec('COMMIT'); transaction = false
        return { board, duplicate: true }
      }
      const changed = change(board), at = this.now()
      for (const card of board.cards) {
        const old = before.cards.find(row => row.membershipId === card.membershipId)
        if (old && card.workflowRevision !== old.workflowRevision) {
          card.workflowRevision = before.revision + 1
          if (card.placementWitness) card.placementWitness.workflowRevision = card.workflowRevision
        }
      }
      const pending = boardEvents(before, board, at)
      for (const card of board.cards) if (!before.cards.some(old => old.membershipId === card.membershipId)) {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM memberships').get()?.count
        if (typeof count !== 'number' || count >= MEMBER_CAPACITY) fail('STORAGE', '成员身份记录达到容量上限；需离线备份及维护，未创建卡片')
        this.db.prepare('INSERT INTO memberships (id, generation, source, source_digest) VALUES (?, 0, NULL, NULL)').run(card.membershipId)
      }
      for (const event of pending) if (['removed', 'archived', 'host_archive', 'episode_started', 'decision', 'workflow', 'project'].includes(event.kind)) { this.db.prepare('UPDATE memberships SET generation=generation+1 WHERE id=?').run(event.membershipId); if (event.kind === 'removed') this.db.prepare('DELETE FROM session_checkpoints WHERE session_id=?').run(event.sessionId) }
      for (const replay of sources) {
        const card = board.cards.find(row => row.sessionId === replay.sessionId)
        if (card && rebaseline.has(card.membershipId)) this.db.prepare('UPDATE memberships SET source=NULL, source_digest=NULL WHERE id=?').run(card.membershipId)
        if (card) pending.push(...this.recordSource(card, replay, at))
      }
      this.businessHistory.changes(before, board, at, receipt?.requestId ?? null)
      if (changed) {
        board.revision += 1
        const stored = toStoredBoard(board)
        // One validation pass: parseStoredBoard enforces the durable form (canonical
        // shape, one tag per group) and returns the runtime projection, which is also
        // what the cache publishes — a reopen must see exactly this aggregate.
        const published = parseStoredBoard(stored)
        const payload = JSON.stringify(stored), digest = digestCommand(payload)
        this.db.prepare('UPDATE board SET revision=?, payload=?, digest=? WHERE id=1').run(board.revision, payload, digest)
        pendingBoard = { revision: board.revision, payload, digest, board: published }
      }
      if (pending.length) {
        const meta = this.meta()
        for (const item of pending) {
          meta.highWatermark += 1
          const { card, ...fields } = item
          const event: DomainEvent = { ...fields, schemaVersion: 2, eventId: randomUUID(), sequence: meta.highWatermark, scope: meta.scope, observedAt: at, committedAt: at, boardRevision: board.revision, summary: card ? this.summary(card, board) : null }
          const payload = JSON.stringify(domainEventSchema.parse(event))
          this.db.prepare('INSERT INTO domain_events VALUES (?, ?, ?, ?)').run(event.sequence, at, payload, digestCommand(payload))
        }
        this.db.prepare('DELETE FROM domain_events WHERE seq<=? OR committed_at<?').run(meta.highWatermark - EVENT_CAPACITY, at - EVENT_RETENTION_MS)
        const first = this.db.prepare('SELECT MIN(seq) AS first FROM domain_events').get()?.first
        meta.retainedFrom = typeof first === 'number' ? first : meta.highWatermark + 1
        pendingMetaCache = { ...this.saveMeta(meta), meta }; notify = true
      }
      if (receipt) this.db.prepare('INSERT INTO receipts (request_id, digest) VALUES (?, ?)').run(receipt.requestId, receipt.digest)
      // No await, extension callback or other externally controlled work after this final fence.
      fence(); this.db.exec('COMMIT'); transaction = false
      // Publish only committed decodes: a rejected fence or rollback above leaves the
      // previous cache (which still matches the rolled-back row) untouched.
      // Store an isolated decode: the caller (and the change callback it may have
      // retained) owns `board` after this point and must not mutate the cache.
      if (pendingBoard) this.boardCache = { ...pendingBoard, board: structuredClone(pendingBoard.board) }
      if (pendingMetaCache) this.metaCache = pendingMetaCache
      result = { board, duplicate: false }
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK')
      if (error instanceof DashboardError) throw error
      fail('STORAGE', `仪表板事务未保存：${errorText(error)}`)
    }
    if (notify) for (const listener of this.listeners) { try { listener() } catch { /* advisory feed, durable replay remains authoritative */ } }
    return result
  }
  close(): void { if (!this.closed) { this.closed = true; this.listeners.clear(); this.db.close() } }
}
