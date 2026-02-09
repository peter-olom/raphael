import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.RAPHAEL_DB_PATH || path.join(__dirname, '../../../data/raphael.db');

function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseSqliteSynchronous(raw: unknown): 'FULL' | 'NORMAL' | 'OFF' {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'FULL' || v === 'NORMAL' || v === 'OFF') return v;
  return 'NORMAL';
}

// Keep main DB + auth DB consistent.
export function applySqlitePragmas(db: any) {
  // WAL is required for decent concurrent read/write behavior.
  db.pragma('journal_mode = WAL');

  const sync = parseSqliteSynchronous(process.env.RAPHAEL_SQLITE_SYNCHRONOUS);
  db.pragma(`synchronous = ${sync}`);

  const busyTimeoutMs = parsePositiveInt(process.env.RAPHAEL_SQLITE_BUSY_TIMEOUT_MS, 5000);
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const walAutocheckpointPages = parsePositiveInt(process.env.RAPHAEL_SQLITE_WAL_AUTOCHECKPOINT_PAGES, 1000);
  db.pragma(`wal_autocheckpoint = ${walAutocheckpointPages}`);
}

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
applySqlitePragmas(db);

const DEFAULT_TRACES_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3d
const DEFAULT_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// Create tables
	db.exec(`
	  CREATE TABLE IF NOT EXISTS drops (
	    id INTEGER PRIMARY KEY AUTOINCREMENT,
	    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	    label TEXT,
	    created_at INTEGER DEFAULT (unixepoch() * 1000)
	  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expiresAt INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    password TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drop_retention (
    drop_id INTEGER PRIMARY KEY,
    traces_retention_ms INTEGER,
    events_retention_ms INTEGER,
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dashboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
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

  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS user_drop_permissions (
    user_id TEXT NOT NULL,
    drop_id INTEGER NOT NULL,
    can_ingest INTEGER NOT NULL DEFAULT 0,
    can_query INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (user_id, drop_id),
    FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS service_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE,
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    UNIQUE(created_by_user_id, name)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_account_id INTEGER NOT NULL,
    name TEXT,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    revoked_at INTEGER,
    FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_key_permissions (
    api_key_id INTEGER NOT NULL,
    drop_id INTEGER NOT NULL,
    can_ingest INTEGER NOT NULL DEFAULT 0,
    can_query INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, drop_id),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_key_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL,
    drop_id INTEGER,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE SET NULL
  );
`);

function columnExists(table: string, column: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .all(table, column) as Array<{ name: string }>;
  return rows.length > 0;
}

// Lightweight migrations for older DBs.
const addedDropsLabel = !columnExists('drops', 'label');
if (addedDropsLabel) {
  db.exec(`ALTER TABLE drops ADD COLUMN label TEXT;`);
  // One-time backfill so older DBs don't suddenly show "default" in the UI.
  db.prepare(`UPDATE drops SET label = ? WHERE name = ? AND label IS NULL`).run('Default', 'default');
}

function ensureDefaultDrop(): number {
  // Default drop identity is stable ('default'); label is user-facing.
  db.prepare(`INSERT OR IGNORE INTO drops (name, label) VALUES (?, ?)`).run('default', 'Default');
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

// Migrate service_accounts from global unique name -> per-user unique(name)
try {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'service_accounts'`)
    .get() as { sql?: string } | undefined;
  const createSql = row?.sql ?? '';
  const isLegacy = createSql.includes('name TEXT NOT NULL UNIQUE') && !createSql.includes('UNIQUE(created_by_user_id, name)');
  if (isLegacy) {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    // Avoid renaming the original table, because SQLite will rewrite foreign key references in other tables.
    db.exec(`
      CREATE TABLE service_accounts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(created_by_user_id, name)
      );
    `);
    db.exec(`
      INSERT INTO service_accounts_new (id, name, created_by_user_id, created_at, updated_at)
      SELECT id, name, created_by_user_id, created_at, updated_at
      FROM service_accounts;
    `);
    db.exec(`DROP TABLE service_accounts;`);
    db.exec(`ALTER TABLE service_accounts_new RENAME TO service_accounts;`);
    db.exec(`PRAGMA foreign_keys = ON;`);
  }
} catch (error) {
  // Keep startup resilient; legacy DBs may still have a globally-unique service_accounts.name.
  console.warn('service_accounts migration failed:', error);
}

// Repair/migrate legacy api_keys tables that reference service_accounts_old (and/or old users table).
// This can happen if service_accounts was renamed in older migrations: SQLite rewrites FK references.
try {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'`)
    .get() as { sql?: string } | undefined;
  const createSql = row?.sql ?? '';
  const legacyFk = createSql.includes('service_accounts_old');
  const legacyCreatedBy = createSql.includes('created_by_user_id INTEGER') || createSql.includes('REFERENCES users');
  if (legacyFk || legacyCreatedBy) {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    db.exec(`
      CREATE TABLE api_keys_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_account_id INTEGER NOT NULL,
        name TEXT,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        revoked_at INTEGER,
        FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO api_keys_new (id, service_account_id, name, key_prefix, key_hash, created_by_user_id, created_at, revoked_at)
      SELECT k.id,
             k.service_account_id,
             k.name,
             k.key_prefix,
             k.key_hash,
             COALESCE(sa.created_by_user_id, CAST(k.created_by_user_id AS TEXT)) as created_by_user_id,
             k.created_at,
             k.revoked_at
      FROM api_keys k
      LEFT JOIN service_accounts sa ON sa.id = k.service_account_id;
    `);
    db.exec(`DROP TABLE api_keys;`);
    db.exec(`ALTER TABLE api_keys_new RENAME TO api_keys;`);
    db.exec(`PRAGMA foreign_keys = ON;`);
  }
} catch (error) {
  console.warn('api_keys migration failed:', error);
}

// Indexes that depend on drop_id (must run after migrations)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_settings_updated ON app_settings(updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(userId);
  CREATE INDEX IF NOT EXISTS idx_account_user ON account(userId);
  CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

  CREATE INDEX IF NOT EXISTS idx_dashboards_drop_updated ON dashboards(drop_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_traces_drop_created ON traces(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_trace_id ON traces(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service_name);

  CREATE INDEX IF NOT EXISTS idx_events_drop_created ON wide_events(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_trace_id ON wide_events(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_service ON wide_events(service_name);
  CREATE INDEX IF NOT EXISTS idx_events_outcome ON wide_events(outcome);

  CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
  CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);

  CREATE INDEX IF NOT EXISTS idx_user_drop_permissions_user ON user_drop_permissions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_drop_permissions_drop ON user_drop_permissions(drop_id);

  CREATE INDEX IF NOT EXISTS idx_service_accounts_created_by ON service_accounts(created_by_user_id);

  CREATE INDEX IF NOT EXISTS idx_api_keys_service_account ON api_keys(service_account_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by_user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

  CREATE INDEX IF NOT EXISTS idx_api_key_permissions_drop ON api_key_permissions(drop_id);
  CREATE INDEX IF NOT EXISTS idx_api_key_usage_key ON api_key_usage(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_api_key_usage_drop ON api_key_usage(drop_id);
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

export type TraceInsertRow = {
  drop_id: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  operation_name: string;
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  status: string;
  attributes: string;
};

export type WideEventInsertRow = {
  drop_id: number;
  trace_id: string | null;
  service_name: string;
  operation_type: string | null;
  field_name: string | null;
  outcome: string;
  duration_ms: number | null;
  user_id: string | null;
  error_count: number;
  rpc_call_count: number;
  attributes: string;
};

const insertTracesTx = db.transaction((rows: TraceInsertRow[]) => {
  for (const r of rows) {
    insertTraceStmt.run(
      r.drop_id,
      r.trace_id,
      r.span_id,
      r.parent_span_id,
      r.service_name,
      r.operation_name,
      r.start_time,
      r.end_time,
      r.duration_ms,
      r.status,
      r.attributes
    );
  }
});

const insertWideEventsTx = db.transaction((rows: WideEventInsertRow[]) => {
  for (const r of rows) {
    insertWideEventStmt.run(
      r.drop_id,
      r.trace_id,
      r.service_name,
      r.operation_type,
      r.field_name,
      r.outcome,
      r.duration_ms,
      r.user_id,
      r.error_count,
      r.rpc_call_count,
      r.attributes
    );
  }
});

export function insertTraceRows(rows: TraceInsertRow[]) {
  if (rows.length === 0) return;
  insertTracesTx(rows);
}

export function insertWideEventRows(rows: WideEventInsertRow[]) {
  if (rows.length === 0) return;
  insertWideEventsTx(rows);
}

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
  insertTraceRows([
    {
      drop_id: dropId,
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      service_name: serviceName,
      operation_name: operationName,
      start_time: startTime,
      end_time: endTime,
      duration_ms: durationMs,
      status,
      attributes,
    },
  ]);
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
  insertWideEventRows([
    {
      drop_id: dropId,
      trace_id: traceId,
      service_name: serviceName,
      operation_type: operationType,
      field_name: fieldName,
      outcome,
      duration_ms: durationMs,
      user_id: userId,
      error_count: errorCount,
      rpc_call_count: rpcCallCount,
      attributes,
    },
  ]);
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
        SELECT d.id, d.name, d.label, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        ORDER BY d.created_at DESC
      `
    )
    .all() as Array<{
    id: number;
    name: string;
    label: string | null;
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
        SELECT d.id, d.name, d.label, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        ORDER BY d.created_at DESC
      `
    )
    .all() as Array<{
    id: number;
    name: string;
    label: string | null;
    created_at: number;
    traces_retention_ms: number | null;
    events_retention_ms: number | null;
    updated_at: number | null;
  }>;
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
        SELECT d.id, d.name, d.label, d.created_at,
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
    | { id: number; name: string; label: string | null; created_at: number }
    | undefined;
}

export function getDropByName(name: string) {
  return db.prepare(`SELECT * FROM drops WHERE name = ?`).get(name.trim()) as
    | { id: number; name: string; label: string | null; created_at: number }
    | undefined;
}

export function setDropLabel(dropId: number, label: string | null) {
  if (!Number.isFinite(dropId) || dropId <= 0) throw new Error('Invalid drop id');
  if (!getDropById(dropId)) throw new Error('Drop not found');
  const normalized = (label ?? '').trim();
  const nextLabel = normalized ? normalized : null;
  if (nextLabel && nextLabel.length > 128) throw new Error('Drop label too long (max 128 chars)');

  ensureRetentionRow(dropId);
  db.prepare(`UPDATE drops SET label = ? WHERE id = ?`).run(nextLabel, dropId);
  return db
    .prepare(
      `
        SELECT d.id, d.name, d.label, d.created_at,
               r.traces_retention_ms, r.events_retention_ms, r.updated_at
        FROM drops d
        LEFT JOIN drop_retention r ON r.drop_id = d.id
        WHERE d.id = ?
      `
    )
    .get(dropId) as
    | {
        id: number;
        name: string;
        label: string | null;
        created_at: number;
        traces_retention_ms: number | null;
        events_retention_ms: number | null;
        updated_at: number | null;
      }
	    | undefined;
}

function countDrops(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM drops`).get() as { count: number };
  return Number(row?.count ?? 0);
}

export function deleteDrop(dropId: number) {
  if (!Number.isFinite(dropId) || dropId <= 0) throw new Error('Invalid drop id');
  if (dropId === DEFAULT_DROP_ID) throw new Error('Cannot delete the default drop');
  if (!getDropById(dropId)) throw new Error('Drop not found');
  if (countDrops() <= 1) throw new Error('Cannot delete the last drop');

  // Do explicit deletes so this works even if SQLite foreign_keys is disabled,
  // and because some tables (traces/wide_events) do not have FK constraints.
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM traces WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM wide_events WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM dashboards WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM drop_retention WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM user_drop_permissions WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM api_key_permissions WHERE drop_id = ?`).run(dropId);
    db.prepare(`UPDATE api_key_usage SET drop_id = NULL WHERE drop_id = ?`).run(dropId);
    db.prepare(`DELETE FROM drops WHERE id = ?`).run(dropId);
  });

  tx();
  return { success: true };
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

export function resolveDropId(nameOrId?: string | null, allowCreate = true): number | null {
  const raw = (nameOrId ?? '').trim();
  if (!raw) return DEFAULT_DROP_ID;

  if (/^\d+$/.test(raw)) {
    const dropId = Number.parseInt(raw, 10);
    const existing = getDropById(dropId)?.id;
    if (existing) return existing;
    return allowCreate ? DEFAULT_DROP_ID : null;
  }

  const existing = getDropByName(raw);
  if (existing) return existing.id;
  if (!allowCreate) return null;

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

const deleteOldTracesBatch = db.prepare(`
  DELETE FROM traces
  WHERE rowid IN (
    SELECT rowid
    FROM traces
    WHERE drop_id = ? AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  )
`);

const deleteOldEventsBatch = db.prepare(`
  DELETE FROM wide_events
  WHERE rowid IN (
    SELECT rowid
    FROM wide_events
    WHERE drop_id = ? AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  )
`);

export function pruneByRetention(dropId?: number, now = Date.now()) {
  const drops = dropId === undefined ? (db.prepare(`SELECT id FROM drops`).all() as Array<{ id: number }>) : [{ id: dropId }];

  const results: Array<{ drop_id: number; traces_deleted: number; events_deleted: number }> = [];

  const batchSize = parsePositiveInt(process.env.RAPHAEL_PRUNE_BATCH_SIZE, 5000);
  const maxRuntimeMs = parsePositiveInt(process.env.RAPHAEL_PRUNE_MAX_RUNTIME_MS, 250);
  const deadline = Date.now() + maxRuntimeMs;

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

    let tracesDeleted = 0;
    let eventsDeleted = 0;

    if (tracesCutoff !== null) {
      while (Date.now() < deadline) {
        const changes = deleteOldTracesBatch.run(d.id, tracesCutoff, batchSize).changes;
        tracesDeleted += changes;
        if (changes === 0) break;
      }
    }

    if (eventsCutoff !== null) {
      while (Date.now() < deadline) {
        const changes = deleteOldEventsBatch.run(d.id, eventsCutoff, batchSize).changes;
        eventsDeleted += changes;
        if (changes === 0) break;
      }
    }

    results.push({ drop_id: d.id, traces_deleted: tracesDeleted, events_deleted: eventsDeleted });

    // Respect the time budget across drops.
    if (Date.now() >= deadline) break;
  }

  return results;
}

export function listDashboards(dropId: number) {
  return db
    .prepare(
      `
        SELECT id, drop_id, name, spec_json, created_at, updated_at
        FROM dashboards
        WHERE drop_id = ?
        ORDER BY updated_at DESC
      `
    )
    .all(dropId);
}

export function getDashboard(dropId: number, dashboardId: number) {
  return db
    .prepare(
      `
        SELECT id, drop_id, name, spec_json, created_at, updated_at
        FROM dashboards
        WHERE drop_id = ? AND id = ?
      `
    )
    .get(dropId, dashboardId);
}

export function createDashboard(dropId: number, name: string, specJson: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Dashboard name is required');
  const info = db
    .prepare(
      `
        INSERT INTO dashboards (drop_id, name, spec_json)
        VALUES (?, ?, ?)
      `
    )
    .run(dropId, trimmed, specJson);
  return getDashboard(dropId, Number(info.lastInsertRowid));
}

export function updateDashboard(dropId: number, dashboardId: number, name?: string, specJson?: string) {
  const existing = getDashboard(dropId, dashboardId) as any;
  if (!existing) return null;

  const nextName = name === undefined ? existing.name : name.toString().trim();
  if (!nextName) throw new Error('Dashboard name is required');
  const nextSpec = specJson === undefined ? existing.spec_json : specJson;

  db.prepare(
    `
      UPDATE dashboards
      SET name = ?,
          spec_json = ?,
          updated_at = (unixepoch() * 1000)
      WHERE drop_id = ? AND id = ?
    `
  ).run(nextName, nextSpec, dropId, dashboardId);

  return getDashboard(dropId, dashboardId);
}

export function deleteDashboard(dropId: number, dashboardId: number) {
  return db.prepare(`DELETE FROM dashboards WHERE drop_id = ? AND id = ?`).run(dropId, dashboardId).changes > 0;
}

export function getAppSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAppSetting(key: string, value: string) {
  db.prepare(
    `
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = (unixepoch() * 1000)
    `
  ).run(key, value);
}

export function deleteAppSetting(key: string) {
  db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
}

export type UserRole = 'admin' | 'member';

export function countUserProfiles() {
  const row = db.prepare(`SELECT COUNT(*) as count FROM user_profiles`).get() as { count: number };
  return row.count;
}

export function getUserProfile(userId: string) {
  return db
    .prepare(
      `
        SELECT user_id, email, role, disabled, created_at, updated_at, last_login_at
        FROM user_profiles
        WHERE user_id = ?
      `
    )
    .get(userId) as
    | {
        user_id: string;
        email: string;
        role: UserRole;
        disabled: number;
        created_at: number;
        updated_at: number;
        last_login_at: number | null;
      }
    | undefined;
}

export function listUserProfiles() {
  return db
    .prepare(
      `
        SELECT user_id, email, role, disabled, created_at, updated_at, last_login_at
        FROM user_profiles
        ORDER BY created_at DESC
      `
    )
    .all() as Array<{
    user_id: string;
    email: string;
    role: UserRole;
    disabled: number;
    created_at: number;
    updated_at: number;
    last_login_at: number | null;
  }>;
}

export function upsertUserProfile(params: {
  user_id: string;
  email: string;
  role?: UserRole;
  disabled?: boolean;
  last_login_at?: number;
}) {
  const now = Date.now();
  const existing = getUserProfile(params.user_id);
  if (!existing) {
    const role = params.role ?? 'member';
    const disabled = params.disabled ? 1 : 0;
    db.prepare(
      `
        INSERT INTO user_profiles (user_id, email, role, disabled, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(params.user_id, params.email.toLowerCase(), role, disabled, now, now, params.last_login_at ?? now);
  } else {
    const role = params.role ?? existing.role;
    const disabled = params.disabled === undefined ? existing.disabled : params.disabled ? 1 : 0;
    db.prepare(
      `
        UPDATE user_profiles
        SET email = ?,
            role = ?,
            disabled = ?,
            updated_at = (unixepoch() * 1000),
            last_login_at = COALESCE(?, last_login_at)
        WHERE user_id = ?
      `
    ).run(params.email.toLowerCase(), role, disabled, params.last_login_at ?? null, params.user_id);
  }
  return getUserProfile(params.user_id);
}

export function createUserProfileIfMissing(params: { user_id: string; email: string; role: UserRole }) {
  const existing = getUserProfile(params.user_id);
  if (existing) return existing;
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO user_profiles (user_id, email, role, disabled, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, 0, ?, ?, NULL)
    `
  ).run(params.user_id, params.email.toLowerCase(), params.role, now, now);
  return getUserProfile(params.user_id);
}

export function updateUserRole(userId: string, role: UserRole) {
  db.prepare(
    `
      UPDATE user_profiles
      SET role = ?,
          updated_at = (unixepoch() * 1000)
      WHERE user_id = ?
    `
  ).run(role, userId);
}

export function updateUserDisabled(userId: string, disabled: boolean) {
  db.prepare(
    `
      UPDATE user_profiles
      SET disabled = ?,
          updated_at = (unixepoch() * 1000)
      WHERE user_id = ?
    `
  ).run(disabled ? 1 : 0, userId);
}

export function listUserDropPermissions(userId: string) {
  return db
    .prepare(
      `
        SELECT user_id, drop_id, can_ingest, can_query, created_at, updated_at
        FROM user_drop_permissions
        WHERE user_id = ?
      `
    )
    .all(userId) as Array<{
    user_id: string;
    drop_id: number;
    can_ingest: number;
    can_query: number;
    created_at: number;
    updated_at: number;
  }>;
}

export function getUserDropPermission(userId: string, dropId: number) {
  return db
    .prepare(
      `
        SELECT user_id, drop_id, can_ingest, can_query
        FROM user_drop_permissions
        WHERE user_id = ? AND drop_id = ?
      `
    )
    .get(userId, dropId) as
    | { user_id: string; drop_id: number; can_ingest: number; can_query: number }
    | undefined;
}

export function listDropsForOwnerAccess(ownerUserId: string) {
  return db
    .prepare(
      `
        SELECT d.id, d.name, d.label, d.created_at,
               p.can_ingest, p.can_query
        FROM user_drop_permissions p
        INNER JOIN drops d ON d.id = p.drop_id
        WHERE p.user_id = ?
          AND (p.can_ingest = 1 OR p.can_query = 1)
        ORDER BY d.created_at DESC
      `
    )
    .all(ownerUserId) as Array<{
    id: number;
    name: string;
    label: string | null;
    created_at: number;
    can_ingest: number;
    can_query: number;
  }>;
}

export function setUserDropPermissions(
  userId: string,
  permissions: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
) {
  const insert = db.prepare(
    `
      INSERT INTO user_drop_permissions (user_id, drop_id, can_ingest, can_query, updated_at)
      VALUES (?, ?, ?, ?, (unixepoch() * 1000))
    `
  );
  const clear = db.prepare(`DELETE FROM user_drop_permissions WHERE user_id = ?`);
  const tx = db.transaction((rows: typeof permissions) => {
    clear.run(userId);
    for (const row of rows) {
      if (!row.can_ingest && !row.can_query) continue;
      insert.run(userId, row.drop_id, row.can_ingest ? 1 : 0, row.can_query ? 1 : 0);
    }
  });
  tx(permissions);
}

export function hasAnyUserDropPermissions(userId: string) {
  const row = db
    .prepare(
      `
        SELECT 1 as ok
        FROM user_drop_permissions
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .get(userId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

export function listServiceAccounts(ownerUserId: string) {
  return db
    .prepare(
      `
      SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
             up.email as created_by_email
      FROM service_accounts sa
      LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
      WHERE sa.created_by_user_id = ?
      ORDER BY sa.created_at DESC
      `
    )
    .all(ownerUserId) as Array<{
    id: number;
    name: string;
    created_by_user_id: string;
    created_by_email: string | null;
    created_at: number;
    updated_at: number;
  }>;
}

export function createServiceAccount(name: string, createdByUserId: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Service account name is required');
  if (trimmed.length > 64) throw new Error('Service account name too long (max 64 chars)');

  const info = db
    .prepare(`INSERT INTO service_accounts (name, created_by_user_id) VALUES (?, ?)`)
    .run(trimmed, createdByUserId);
  const id = Number(info.lastInsertRowid);
  return db
    .prepare(
      `
        SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
               up.email as created_by_email
        FROM service_accounts sa
        LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
        WHERE sa.id = ?
      `
    )
    .get(id);
}

export function deleteServiceAccountOwned(id: number, ownerUserId: string) {
  return (
    db.prepare(`DELETE FROM service_accounts WHERE id = ? AND created_by_user_id = ?`).run(id, ownerUserId).changes > 0
  );
}

export function listApiKeys(serviceAccountId?: number) {
  const clause = serviceAccountId ? 'WHERE service_account_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT k.id, k.service_account_id, k.name, k.key_prefix, k.created_by_user_id, k.created_at, k.revoked_at,
             sa.name as service_account_name,
             up.email as created_by_email
      FROM api_keys k
      LEFT JOIN service_accounts sa ON sa.id = k.service_account_id
      LEFT JOIN user_profiles up ON up.user_id = k.created_by_user_id
      ${clause}
      ORDER BY k.created_at DESC
    `
  );
  return serviceAccountId ? stmt.all(serviceAccountId) : stmt.all();
}

export function listApiKeysForOwner(ownerUserId: string, serviceAccountId?: number) {
  const clause = serviceAccountId ? 'AND k.service_account_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT k.id, k.service_account_id, k.name, k.key_prefix, k.created_by_user_id, k.created_at, k.revoked_at,
             sa.name as service_account_name,
             up.email as created_by_email
      FROM api_keys k
      INNER JOIN service_accounts sa ON sa.id = k.service_account_id
      LEFT JOIN user_profiles up ON up.user_id = k.created_by_user_id
      WHERE sa.created_by_user_id = ?
      ${clause}
      ORDER BY k.created_at DESC
    `
  );
  return serviceAccountId ? stmt.all(ownerUserId, serviceAccountId) : stmt.all(ownerUserId);
}

export function getServiceAccountById(id: number) {
  return db
    .prepare(
      `
        SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
               up.email as created_by_email
        FROM service_accounts sa
        LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
        WHERE sa.id = ?
      `
    )
    .get(id) as
    | {
        id: number;
        name: string;
        created_by_user_id: string;
        created_by_email: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
}

export function createApiKey(
  serviceAccountId: number,
  name: string | null,
  keyPrefix: string,
  keyHash: string,
  createdByUserId: string
) {
  const info = db
    .prepare(
      `
        INSERT INTO api_keys (service_account_id, name, key_prefix, key_hash, created_by_user_id)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(serviceAccountId, name, keyPrefix, keyHash, createdByUserId);
  const id = Number(info.lastInsertRowid);
  return db
    .prepare(
      `
        SELECT id, service_account_id, name, key_prefix, created_by_user_id, created_at, revoked_at
        FROM api_keys
        WHERE id = ?
      `
    )
    .get(id);
}

export function revokeApiKey(id: number) {
  return (
    db
      .prepare(`UPDATE api_keys SET revoked_at = (unixepoch() * 1000) WHERE id = ? AND revoked_at IS NULL`)
      .run(id).changes > 0
  );
}

export function revokeApiKeyOwned(apiKeyId: number, ownerUserId: string) {
  return (
    db
      .prepare(
        `
          UPDATE api_keys
          SET revoked_at = (unixepoch() * 1000)
          WHERE id = ?
            AND revoked_at IS NULL
            AND service_account_id IN (
              SELECT id FROM service_accounts WHERE created_by_user_id = ?
            )
        `
      )
      .run(apiKeyId, ownerUserId).changes > 0
  );
}

export function getApiKeyByHash(keyHash: string) {
  return db
    .prepare(
      `
        SELECT id, service_account_id, name, key_prefix, created_by_user_id, created_at, revoked_at
        FROM api_keys
        WHERE key_hash = ?
      `
    )
    .get(keyHash) as
    | {
        id: number;
        service_account_id: number;
        name: string | null;
        key_prefix: string;
        created_by_user_id: string;
        created_at: number;
        revoked_at: number | null;
      }
    | undefined;
}

export function setApiKeyPermissions(
  apiKeyId: number,
  permissions: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
) {
  const stmt = db.prepare(
    `
      INSERT INTO api_key_permissions (api_key_id, drop_id, can_ingest, can_query)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(api_key_id, drop_id) DO UPDATE SET
        can_ingest = excluded.can_ingest,
        can_query = excluded.can_query
    `
  );
  const tx = db.transaction((rows: typeof permissions) => {
    for (const row of rows) {
      stmt.run(apiKeyId, row.drop_id, row.can_ingest ? 1 : 0, row.can_query ? 1 : 0);
    }
  });
  tx(permissions);
}

export function getApiKeyPermissions(apiKeyId: number) {
  return db
    .prepare(
      `
        SELECT api_key_id, drop_id, can_ingest, can_query
        FROM api_key_permissions
        WHERE api_key_id = ?
      `
    )
    .all(apiKeyId) as Array<{
    api_key_id: number;
    drop_id: number;
    can_ingest: number;
    can_query: number;
  }>;
}

export function logApiKeyUsage(entry: {
  api_key_id: number;
  drop_id: number | null;
  method: string;
  path: string;
  status_code: number;
  ip_address?: string | null;
  user_agent?: string | null;
}) {
  db.prepare(
    `
      INSERT INTO api_key_usage (api_key_id, drop_id, method, path, status_code, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    entry.api_key_id,
    entry.drop_id,
    entry.method,
    entry.path,
    entry.status_code,
    entry.ip_address ?? null,
    entry.user_agent ?? null
  );
}

export function listApiKeyUsage(apiKeyId?: number, limit = 200, offset = 0) {
  const lim = clampLimit(limit);
  const off = clampOffset(offset);
  const clause = apiKeyId ? 'WHERE u.api_key_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT u.id, u.api_key_id, u.drop_id, u.method, u.path, u.status_code, u.ip_address, u.user_agent, u.created_at,
             k.key_prefix, k.name as api_key_name,
             sa.name as service_account_name
      FROM api_key_usage u
      LEFT JOIN api_keys k ON k.id = u.api_key_id
      LEFT JOIN service_accounts sa ON sa.id = k.service_account_id
      ${clause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `
  );
  return apiKeyId ? stmt.all(apiKeyId, lim, off) : stmt.all(lim, off);
}

export function listApiKeyUsageForOwner(ownerUserId: string, apiKeyId?: number, limit = 200, offset = 0) {
  const lim = clampLimit(limit);
  const off = clampOffset(offset);
  const clause = apiKeyId ? 'AND u.api_key_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT u.id, u.api_key_id, u.drop_id, u.method, u.path, u.status_code, u.ip_address, u.user_agent, u.created_at,
             k.key_prefix, k.name as api_key_name,
             sa.name as service_account_name
      FROM api_key_usage u
      INNER JOIN api_keys k ON k.id = u.api_key_id
      INNER JOIN service_accounts sa ON sa.id = k.service_account_id
      WHERE sa.created_by_user_id = ?
      ${clause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `
  );
  return apiKeyId ? stmt.all(ownerUserId, apiKeyId, lim, off) : stmt.all(ownerUserId, lim, off);
}

export interface TraceQuery {
  q?: string;
  where?: Partial<{
    trace_id: string;
    service_name: string;
    operation_name: string;
    status: string;
  }>;
  range?: Partial<{
    start_time: { gte?: number; lte?: number };
    end_time: { gte?: number; lte?: number };
    duration_ms: { gte?: number; lte?: number };
    created_at: { gte?: number; lte?: number };
  }>;
  attributes?: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }>;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface WideEventQuery {
  q?: string;
  where?: Partial<{
    trace_id: string;
    service_name: string;
    operation_type: string;
    field_name: string;
    outcome: string;
    user_id: string;
  }>;
  range?: Partial<{
    duration_ms: { gte?: number; lte?: number };
    created_at: { gte?: number; lte?: number };
    error_count: { gte?: number; lte?: number };
    rpc_call_count: { gte?: number; lte?: number };
  }>;
  attributes?: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }>;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

function jsonPath(key: string) {
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `$."${escaped}"`;
}

function applyRange<T extends Record<string, { gte?: number; lte?: number }>>(
  field: string,
  range: T | undefined,
  where: string[],
  params: unknown[]
) {
  if (!range) return;
  const clause = range[field as keyof T] as { gte?: number; lte?: number } | undefined;
  if (!clause) return;
  if (clause.gte !== undefined) {
    where.push(`${field} >= ?`);
    params.push(clause.gte);
  }
  if (clause.lte !== undefined) {
    where.push(`${field} <= ?`);
    params.push(clause.lte);
  }
}

function applyAttributes(
  attrs: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }> | undefined,
  where: string[],
  params: unknown[]
) {
  if (!attrs || attrs.length === 0) return;
  for (const attr of attrs) {
    const key = attr.key?.toString().trim();
    if (!key) continue;
    const op = attr.op ?? 'eq';
    const path = jsonPath(key);
    if (op === 'exists') {
      where.push(`json_type(json_extract(attributes, ?)) IS NOT NULL`);
      params.push(path);
      continue;
    }
    const value = attr.value;
    if (value === undefined) continue;
    const expr = `json_extract(attributes, ?)`;
    if (op === 'like') {
      where.push(`CAST(${expr} AS TEXT) LIKE ?`);
      params.push(path, `%${value}%`);
    } else if (op === 'gt') {
      where.push(`${expr} > ?`);
      params.push(path, value);
    } else if (op === 'gte') {
      where.push(`${expr} >= ?`);
      params.push(path, value);
    } else if (op === 'lt') {
      where.push(`${expr} < ?`);
      params.push(path, value);
    } else if (op === 'lte') {
      where.push(`${expr} <= ?`);
      params.push(path, value);
    } else {
      where.push(`${expr} = ?`);
      params.push(path, value);
    }
  }
}

function clampLimit(raw?: number) {
  const limit = raw === undefined ? 100 : Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.max(1, Math.min(2000, Math.floor(limit)));
}

function clampOffset(raw?: number) {
  const offset = raw === undefined ? 0 : Number(raw);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

export function queryTraces(dropId: number, query: TraceQuery) {
  const where: string[] = ['drop_id = ?'];
  const params: unknown[] = [dropId];

  if (query.q) {
    const pattern = `%${query.q}%`;
    where.push(`(service_name LIKE ? OR operation_name LIKE ? OR trace_id LIKE ? OR attributes LIKE ?)`);
    params.push(pattern, pattern, pattern, pattern);
  }

  if (query.where?.trace_id) {
    where.push(`trace_id = ?`);
    params.push(query.where.trace_id);
  }
  if (query.where?.service_name) {
    where.push(`service_name = ?`);
    params.push(query.where.service_name);
  }
  if (query.where?.operation_name) {
    where.push(`operation_name = ?`);
    params.push(query.where.operation_name);
  }
  if (query.where?.status) {
    where.push(`status = ?`);
    params.push(query.where.status);
  }

  applyRange('start_time', query.range, where, params);
  applyRange('end_time', query.range, where, params);
  applyRange('duration_ms', query.range, where, params);
  applyRange('created_at', query.range, where, params);

  applyAttributes(query.attributes, where, params);

  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const sql = `
    SELECT * FROM traces
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ${order}
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, limit, offset);
}

export function queryWideEvents(dropId: number, query: WideEventQuery) {
  const where: string[] = ['drop_id = ?'];
  const params: unknown[] = [dropId];

  if (query.q) {
    const pattern = `%${query.q}%`;
    where.push(`(service_name LIKE ? OR field_name LIKE ? OR trace_id LIKE ? OR user_id LIKE ? OR attributes LIKE ?)`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  if (query.where?.trace_id) {
    where.push(`trace_id = ?`);
    params.push(query.where.trace_id);
  }
  if (query.where?.service_name) {
    where.push(`service_name = ?`);
    params.push(query.where.service_name);
  }
  if (query.where?.operation_type) {
    where.push(`operation_type = ?`);
    params.push(query.where.operation_type);
  }
  if (query.where?.field_name) {
    where.push(`field_name = ?`);
    params.push(query.where.field_name);
  }
  if (query.where?.outcome) {
    where.push(`outcome = ?`);
    params.push(query.where.outcome);
  }
  if (query.where?.user_id) {
    where.push(`user_id = ?`);
    params.push(query.where.user_id);
  }

  applyRange('duration_ms', query.range, where, params);
  applyRange('created_at', query.range, where, params);
  applyRange('error_count', query.range, where, params);
  applyRange('rpc_call_count', query.range, where, params);

  applyAttributes(query.attributes, where, params);

  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const sql = `
    SELECT * FROM wide_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ${order}
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, limit, offset);
}
