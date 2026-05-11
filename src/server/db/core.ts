import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DB_PATH } from '../paths.js';

export { DB_PATH };

export function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseSqliteSynchronous(raw: unknown): 'FULL' | 'NORMAL' | 'OFF' {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'FULL' || v === 'NORMAL' || v === 'OFF') return v;
  return 'NORMAL';
}

export function isTruthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function clampLimit(raw?: number, max = 2000) {
  const limit = raw === undefined ? 100 : Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export function clampOffset(raw?: number) {
  const offset = raw === undefined ? 0 : Number(raw);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

// Keep main DB + auth DB consistent.
export function applySqlitePragmas(db: any) {
  db.pragma('foreign_keys = ON');
  // WAL is required for decent concurrent read/write behavior.
  db.pragma('journal_mode = WAL');

  const sync = parseSqliteSynchronous(process.env.RAPHAEL_SQLITE_SYNCHRONOUS);
  db.pragma(`synchronous = ${sync}`);

  const busyTimeoutMs = parsePositiveInt(process.env.RAPHAEL_SQLITE_BUSY_TIMEOUT_MS, 5000);
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const walAutocheckpointPages = parsePositiveInt(process.env.RAPHAEL_SQLITE_WAL_AUTOCHECKPOINT_PAGES, 1000);
  db.pragma(`wal_autocheckpoint = ${walAutocheckpointPages}`);
}

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: any = new Database(DB_PATH);
applySqlitePragmas(db);
db.pragma('auto_vacuum = INCREMENTAL');

const DEFAULT_TRACES_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3d
const DEFAULT_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER DEFAULT (unixepoch() * 1000)
  );

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

function markMigration(id: string) {
  db.prepare(`INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)`).run(id);
}

function runMigration(id: string, fn: () => void) {
  const row = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(id) as { id: string } | undefined;
  if (row) return;
  fn();
  markMigration(id);
}

markMigration('bootstrap-schema-2026-05-11');

function columnExists(table: string, column: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .all(table, column) as Array<{ name: string }>;
  return rows.length > 0;
}

runMigration('drops-label-2026-05-11', () => {
  if (!columnExists('drops', 'label')) {
    db.exec(`ALTER TABLE drops ADD COLUMN label TEXT;`);
  }
  // One-time backfill so older DBs don't suddenly show "default" in the UI.
  db.prepare(`UPDATE drops SET label = ? WHERE name = ? AND label IS NULL`).run('Default', 'default');
});

function ensureDefaultDrop(): number {
  // Default drop identity is stable ('default'); label is user-facing.
  db.prepare(`INSERT OR IGNORE INTO drops (name, label) VALUES (?, ?)`).run('default', 'Default');
  const row = db.prepare(`SELECT id FROM drops WHERE name = ?`).get('default') as { id: number };
  return row.id;
}

export const DEFAULT_DROP_ID = ensureDefaultDrop();

export function ensureRetentionRow(dropId: number) {
  db.prepare(
    `
      INSERT INTO drop_retention (drop_id, traces_retention_ms, events_retention_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(drop_id) DO NOTHING
    `
  ).run(dropId, DEFAULT_TRACES_RETENTION_MS, DEFAULT_EVENTS_RETENTION_MS);
}

runMigration('drop-id-columns-2026-05-11', () => {
  if (!columnExists('traces', 'drop_id')) {
    db.exec(`ALTER TABLE traces ADD COLUMN drop_id INTEGER NOT NULL DEFAULT ${DEFAULT_DROP_ID};`);
  }
  if (!columnExists('wide_events', 'drop_id')) {
    db.exec(`ALTER TABLE wide_events ADD COLUMN drop_id INTEGER NOT NULL DEFAULT ${DEFAULT_DROP_ID};`);
  }
});
ensureRetentionRow(DEFAULT_DROP_ID);

// Migrate service_accounts from global unique name -> per-user unique(name)
try {
  runMigration('service-accounts-per-owner-2026-05-11', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'service_accounts'`)
      .get() as { sql?: string } | undefined;
    const createSql = row?.sql ?? '';
    const isLegacy = createSql.includes('name TEXT NOT NULL UNIQUE') && !createSql.includes('UNIQUE(created_by_user_id, name)');
    if (!isLegacy) return;

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
  });
} catch (error) {
  db.exec(`PRAGMA foreign_keys = ON;`);
  // Keep startup resilient; legacy DBs may still have a globally-unique service_accounts.name.
  console.warn('service_accounts migration failed:', error);
}

// Repair/migrate legacy api_keys tables that reference service_accounts_old (and/or old users table).
// This can happen if service_accounts was renamed in older migrations: SQLite rewrites FK references.
try {
  runMigration('api-keys-fk-repair-2026-05-11', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'`)
      .get() as { sql?: string } | undefined;
    const createSql = row?.sql ?? '';
    const legacyFk = createSql.includes('service_accounts_old');
    const legacyCreatedBy = createSql.includes('created_by_user_id INTEGER') || createSql.includes('REFERENCES users');
    if (!legacyFk && !legacyCreatedBy) return;

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
  });
} catch (error) {
  db.exec(`PRAGMA foreign_keys = ON;`);
  console.warn('api_keys migration failed:', error);
}

runMigration('trace-span-dedup-2026-05-11', () => {
  db.exec(`
    DELETE FROM traces
    WHERE span_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM traces
        WHERE span_id IS NOT NULL
        GROUP BY drop_id, trace_id, span_id
      );
  `);
});

// Indexes that depend on drop_id (must run after migrations)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_settings_updated ON app_settings(updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(userId);
  CREATE INDEX IF NOT EXISTS idx_account_user ON account(userId);
  CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

  CREATE INDEX IF NOT EXISTS idx_dashboards_drop_updated ON dashboards(drop_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_traces_drop_created ON traces(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_id ON traces(drop_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_trace_id ON traces(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_service_id ON traces(drop_id, service_name, id DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_status_id ON traces(drop_id, status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_drop_operation_id ON traces(drop_id, operation_name, id DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service_name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_unique_span ON traces(drop_id, trace_id, span_id) WHERE span_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_events_drop_created ON wide_events(drop_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_id ON wide_events(drop_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_trace_id ON wide_events(drop_id, trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_drop_service_id ON wide_events(drop_id, service_name, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_outcome_id ON wide_events(drop_id, outcome, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_field_id ON wide_events(drop_id, field_name, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_drop_user_id ON wide_events(drop_id, user_id, id DESC);
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
