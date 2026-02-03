import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.RAPHAEL_DB_PATH || path.join(__dirname, '../../../data/raphael.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

const DEFAULT_TRACES_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3d
const DEFAULT_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS drop_retention (
    drop_id INTEGER PRIMARY KEY,
    traces_retention_ms INTEGER,
    events_retention_ms INTEGER,
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drop_id INTEGER NOT NULL DEFAULT 1,
    trace_id TEXT NOT NULL,
    span_id TEXT,
    parent_span_id TEXT,
    service_name TEXT,
    operation_name TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_ms INTEGER,
    status TEXT,
    attributes TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS wide_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drop_id INTEGER NOT NULL DEFAULT 1,
    trace_id TEXT,
    service_name TEXT,
    operation_type TEXT,
    field_name TEXT,
    outcome TEXT,
    duration_ms INTEGER,
    user_id TEXT,
    error_count INTEGER DEFAULT 0,
    rpc_call_count INTEGER DEFAULT 0,
    attributes TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );
`);

function columnExists(table: string, column: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .all(table, column) as Array<{ name: string }>;
  return rows.length > 0;
}

function ensureDefaultDrop(): number {
  db.prepare(`INSERT OR IGNORE INTO drops (name) VALUES (?)`).run('default');
  const row = db.prepare(`SELECT id FROM drops WHERE name = ?`).get('default') as { id: number };
  return row.id;
}

export const DEFAULT_DROP_ID = ensureDefaultDrop();

function ensureRetentionRow(dropId: number) {
  db.prepare(
    `
      INSERT INTO drop_retention (drop_id, traces_retention_ms, events_retention_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(drop_id) DO NOTHING
    `
  ).run(dropId, DEFAULT_TRACES_RETENTION_MS, DEFAULT_EVENTS_RETENTION_MS);
}

// Migrations for older DBs created before drops existed
if (!columnExists('traces', 'drop_id')) {
  db.exec(`ALTER TABLE traces ADD COLUMN drop_id INTEGER NOT NULL DEFAULT ${DEFAULT_DROP_ID};`);
}
if (!columnExists('wide_events', 'drop_id')) {
  db.exec(`ALTER TABLE wide_events ADD COLUMN drop_id INTEGER NOT NULL DEFAULT ${DEFAULT_DROP_ID};`);
}
ensureRetentionRow(DEFAULT_DROP_ID);

// Indexes that depend on drop_id (must run after migrations)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_traces_drop_created ON traces(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_trace_id ON traces(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service_name);

  CREATE INDEX IF NOT EXISTS idx_events_drop_created ON wide_events(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_trace_id ON wide_events(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_service ON wide_events(service_name);
  CREATE INDEX IF NOT EXISTS idx_events_outcome ON wide_events(outcome);
`);

// Prepared statements for inserts
const insertTraceStmt = db.prepare(`
  INSERT INTO traces (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertWideEventStmt = db.prepare(`
  INSERT INTO wide_events (drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertTraceRow(
  dropId: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  serviceName: string,
  operationName: string,
  startTime: number,
  endTime: number | null,
  durationMs: number | null,
  status: string,
  attributes: string
) {
  insertTraceStmt.run(
    dropId,
    traceId,
    spanId,
    parentSpanId,
    serviceName,
    operationName,
    startTime,
    endTime,
    durationMs,
    status,
    attributes
  );
}

export function insertWideEventRow(
  dropId: number,
  traceId: string | null,
  serviceName: string,
  operationType: string | null,
  fieldName: string | null,
  outcome: string,
  durationMs: number | null,
  userId: string | null,
  errorCount: number,
  rpcCallCount: number,
  attributes: string
) {
  insertWideEventStmt.run(
    dropId,
    traceId,
    serviceName,
    operationType,
    fieldName,
    outcome,
    durationMs,
    userId,
    errorCount,
    rpcCallCount,
    attributes
  );
}

// Query helpers
export function getRecentTraces(dropId: number, limit = 100, offset = 0) {
  return db.prepare(`
    SELECT * FROM traces
    WHERE drop_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(dropId, limit, offset);
}

export function getRecentWideEvents(dropId: number, limit = 100, offset = 0) {
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE drop_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(dropId, limit, offset);
}

export function getTraceById(dropId: number, traceId: string) {
  return db.prepare(`
    SELECT * FROM traces
    WHERE drop_id = ?
      AND trace_id = ?
    ORDER BY start_time ASC
  `).all(dropId, traceId);
}

export function getWideEventsByTraceId(dropId: number, traceId: string) {
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE drop_id = ?
      AND trace_id = ?
    ORDER BY created_at ASC
  `).all(dropId, traceId);
}

export function searchTraces(dropId: number, query: string, limit = 100) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM traces
    WHERE drop_id = ?
      AND (
        service_name LIKE ?
        OR operation_name LIKE ?
        OR trace_id LIKE ?
        OR attributes LIKE ?
      )
    ORDER BY created_at DESC
    LIMIT ?
  `).all(dropId, pattern, pattern, pattern, pattern, limit);
}

export function searchWideEvents(dropId: number, query: string, limit = 100) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE drop_id = ?
      AND (
        service_name LIKE ?
        OR field_name LIKE ?
        OR trace_id LIKE ?
        OR user_id LIKE ?
        OR attributes LIKE ?
      )
    ORDER BY created_at DESC
    LIMIT ?
  `).all(dropId, pattern, pattern, pattern, pattern, pattern, limit);
}

export function getStats(dropId: number) {
  const traceCount = db
    .prepare('SELECT COUNT(*) as count FROM traces WHERE drop_id = ?')
    .get(dropId) as { count: number };
  const eventCount = db
    .prepare('SELECT COUNT(*) as count FROM wide_events WHERE drop_id = ?')
    .get(dropId) as { count: number };
  const errorCount = db
    .prepare('SELECT COUNT(*) as count FROM wide_events WHERE drop_id = ? AND outcome = ?')
    .get(dropId, 'error') as { count: number };

  return {
    traces: traceCount.count,
    wideEvents: eventCount.count,
    errors: errorCount.count,
  };
}

export function clearAll(dropId?: number) {
  if (dropId === undefined) {
    db.exec('DELETE FROM traces; DELETE FROM wide_events;');
    return;
  }
  db.prepare('DELETE FROM traces WHERE drop_id = ?').run(dropId);
  db.prepare('DELETE FROM wide_events WHERE drop_id = ?').run(dropId);
}

export function listDrops() {
  const drops = db
    .prepare(
      `
        SELECT d.id, d.name, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        ORDER BY d.created_at DESC
      `
    )
    .all() as Array<{
    id: number;
    name: string;
    created_at: number;
    traces_retention_ms: number | null;
    events_retention_ms: number | null;
    updated_at: number | null;
  }>;

  // Ensure every drop has a retention row.
  for (const drop of drops) {
    ensureRetentionRow(drop.id);
  }

  return db
    .prepare(
      `
        SELECT d.id, d.name, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        ORDER BY d.created_at DESC
      `
    )
    .all();
}

export function createDrop(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Drop name is required');
  if (trimmed.length > 64) throw new Error('Drop name too long (max 64 chars)');

  const info = db.prepare(`INSERT INTO drops (name) VALUES (?)`).run(trimmed);
  const dropId = Number(info.lastInsertRowid);
  ensureRetentionRow(dropId);
  return db
    .prepare(
      `
        SELECT d.id, d.name, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        WHERE d.id = ?
      `
    )
    .get(dropId);
}

export function getDropById(dropId: number) {
  return db.prepare(`SELECT * FROM drops WHERE id = ?`).get(dropId) as
    | { id: number; name: string; created_at: number }
    | undefined;
}

export function getDropByName(name: string) {
  return db.prepare(`SELECT * FROM drops WHERE name = ?`).get(name.trim()) as
    | { id: number; name: string; created_at: number }
    | undefined;
}

export function ensureDrop(nameOrId?: string | null): number {
  const raw = (nameOrId ?? '').trim();
  if (!raw) return DEFAULT_DROP_ID;

  if (/^\d+$/.test(raw)) {
    const dropId = Number.parseInt(raw, 10);
    return getDropById(dropId)?.id ?? DEFAULT_DROP_ID;
  }

  const existing = getDropByName(raw);
  if (existing) return existing.id;

  const created = createDrop(raw) as { id: number };
  return created.id;
}

export function setDropRetentionMs(dropId: number, tracesRetentionMs: number | null, eventsRetentionMs: number | null) {
  ensureRetentionRow(dropId);
  db.prepare(
    `
      UPDATE drop_retention
      SET traces_retention_ms = ?,
          events_retention_ms = ?,
          updated_at = (unixepoch() * 1000)
      WHERE drop_id = ?
    `
  ).run(tracesRetentionMs, eventsRetentionMs, dropId);
}

export function getDropRetention(dropId: number) {
  ensureRetentionRow(dropId);
  return db
    .prepare(`SELECT * FROM drop_retention WHERE drop_id = ?`)
    .get(dropId) as
    | {
        drop_id: number;
        traces_retention_ms: number | null;
        events_retention_ms: number | null;
        updated_at: number;
      }
    | undefined;
}

const deleteOldTraces = db.prepare(`DELETE FROM traces WHERE drop_id = ? AND created_at < ?`);
const deleteOldEvents = db.prepare(`DELETE FROM wide_events WHERE drop_id = ? AND created_at < ?`);

export function pruneByRetention(dropId?: number, now = Date.now()) {
  const drops = dropId === undefined ? (db.prepare(`SELECT id FROM drops`).all() as Array<{ id: number }>) : [{ id: dropId }];

  const results: Array<{ drop_id: number; traces_deleted: number; events_deleted: number }> = [];

  for (const d of drops) {
    const retention = getDropRetention(d.id);
    if (!retention) continue;

    const tracesCutoff =
      retention.traces_retention_ms && retention.traces_retention_ms > 0
        ? now - retention.traces_retention_ms
        : null;
    const eventsCutoff =
      retention.events_retention_ms && retention.events_retention_ms > 0
        ? now - retention.events_retention_ms
        : null;

    const tracesDeleted = tracesCutoff === null ? 0 : deleteOldTraces.run(d.id, tracesCutoff).changes;
    const eventsDeleted = eventsCutoff === null ? 0 : deleteOldEvents.run(d.id, eventsCutoff).changes;

    results.push({ drop_id: d.id, traces_deleted: tracesDeleted, events_deleted: eventsDeleted });
  }

  return results;
}
