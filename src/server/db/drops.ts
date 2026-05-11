import { db, DEFAULT_DROP_ID, ensureRetentionRow, parsePositiveInt, isTruthy } from './core.js';

function clampInt(raw: unknown, fallback: number, min: number, max: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
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

function isSqliteBusy(error: unknown) {
  const code = (error as any)?.code?.toString?.() ?? '';
  const message = (error as Error)?.message ?? '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(message);
}

export interface RetentionPruneResult {
  drop_id: number;
  traces_deleted: number;
  events_deleted: number;
  batches: number;
  runtime_ms: number;
  timed_out: boolean;
  busy: boolean;
}

export function getRetentionPruneConfig() {
  return {
    batch_size: clampInt(process.env.RAPHAEL_PRUNE_BATCH_SIZE, 1000, 100, 50_000),
    max_runtime_ms: clampInt(process.env.RAPHAEL_PRUNE_MAX_RUNTIME_MS, 100, 25, 5_000),
  };
}

export function pruneByRetention(dropId?: number, now = Date.now()) {
  const drops = dropId === undefined ? (db.prepare(`SELECT id FROM drops`).all() as Array<{ id: number }>) : [{ id: dropId }];

  const results: RetentionPruneResult[] = [];

  const { batch_size: batchSize, max_runtime_ms: maxRuntimeMs } = getRetentionPruneConfig();
  const startedAt = Date.now();
  const deadline = startedAt + maxRuntimeMs;

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
    let batches = 0;
    let busy = false;

    let tracesDone = tracesCutoff === null;
    let eventsDone = eventsCutoff === null;

    while (Date.now() < deadline && (!tracesDone || !eventsDone)) {
      if (!tracesDone && tracesCutoff !== null) {
        try {
          const changes = deleteOldTracesBatch.run(d.id, tracesCutoff, batchSize).changes;
          batches++;
          tracesDeleted += changes;
          if (changes === 0) tracesDone = true;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          busy = true;
          break;
        }
      }

      if (busy || Date.now() >= deadline) break;

      if (!eventsDone && eventsCutoff !== null) {
        try {
          const changes = deleteOldEventsBatch.run(d.id, eventsCutoff, batchSize).changes;
          batches++;
          eventsDeleted += changes;
          if (changes === 0) eventsDone = true;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          busy = true;
          break;
        }
      }
    }

    results.push({
      drop_id: d.id,
      traces_deleted: tracesDeleted,
      events_deleted: eventsDeleted,
      batches,
      runtime_ms: Date.now() - startedAt,
      timed_out: Date.now() >= deadline,
      busy,
    });

    if (busy || Date.now() >= deadline) break;
  }

  return results;
}

export function checkpointDatabase(truncate = false) {
  const mode = truncate ? 'TRUNCATE' : 'PASSIVE';
  db.pragma(`wal_checkpoint(${mode})`);
}

function getFreelistPages() {
  const row = db.pragma('freelist_count', { simple: true });
  const pages = Number(row);
  return Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 0;
}

function shouldRunFullVacuum(freePages: number, explicit?: boolean) {
  if (explicit !== undefined) return explicit;
  if (isTruthy(process.env.RAPHAEL_SQLITE_FULL_VACUUM)) return true;
  const threshold = parsePositiveInt(process.env.RAPHAEL_SQLITE_FULL_VACUUM_MIN_FREE_PAGES, 2048);
  return freePages >= threshold;
}

export function compactDatabase(options: { full?: boolean; reason?: string } = {}) {
  checkpointDatabase(true);
  const beforeFreePages = getFreelistPages();
  try {
    if (beforeFreePages > 0) {
      db.pragma(`incremental_vacuum(${beforeFreePages})`);
    }
  } catch {
    // Older databases may not have incremental auto-vacuum enabled.
  }

  const afterIncrementalFreePages = getFreelistPages();
  if (shouldRunFullVacuum(afterIncrementalFreePages, options.full)) {
    db.exec('VACUUM;');
  }
  db.pragma('optimize');
  return {
    success: true,
    reason: options.reason ?? 'manual',
    freelist_pages_before: beforeFreePages,
    freelist_pages_after: getFreelistPages(),
  };
}
