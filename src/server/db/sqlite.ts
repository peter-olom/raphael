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

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
  CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service_name);
  CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_events_trace_id ON wide_events(trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_service ON wide_events(service_name);
  CREATE INDEX IF NOT EXISTS idx_events_outcome ON wide_events(outcome);
  CREATE INDEX IF NOT EXISTS idx_events_created ON wide_events(created_at DESC);
`);

// Prepared statements for inserts
export const insertTrace = db.prepare(`
  INSERT INTO traces (trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const insertWideEvent = db.prepare(`
  INSERT INTO wide_events (trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Query helpers
export function getRecentTraces(limit = 100, offset = 0) {
  return db.prepare(`
    SELECT * FROM traces
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function getRecentWideEvents(limit = 100, offset = 0) {
  return db.prepare(`
    SELECT * FROM wide_events
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function getTraceById(traceId: string) {
  return db.prepare(`
    SELECT * FROM traces
    WHERE trace_id = ?
    ORDER BY start_time ASC
  `).all(traceId);
}

export function getWideEventsByTraceId(traceId: string) {
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE trace_id = ?
  `).all(traceId);
}

export function searchTraces(query: string, limit = 100) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM traces
    WHERE service_name LIKE ?
       OR operation_name LIKE ?
       OR trace_id LIKE ?
       OR attributes LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, pattern, limit);
}

export function searchWideEvents(query: string, limit = 100) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE service_name LIKE ?
       OR field_name LIKE ?
       OR trace_id LIKE ?
       OR user_id LIKE ?
       OR attributes LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, pattern, pattern, limit);
}

export function getStats() {
  const traceCount = db.prepare('SELECT COUNT(*) as count FROM traces').get() as { count: number };
  const eventCount = db.prepare('SELECT COUNT(*) as count FROM wide_events').get() as { count: number };
  const errorCount = db.prepare('SELECT COUNT(*) as count FROM wide_events WHERE outcome = ?').get('error') as { count: number };

  return {
    traces: traceCount.count,
    wideEvents: eventCount.count,
    errors: errorCount.count,
  };
}

export function clearAll() {
  db.exec('DELETE FROM traces; DELETE FROM wide_events;');
}
