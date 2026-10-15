import Database from 'better-sqlite3';
import { parentPort, workerData } from 'worker_threads';
import { promises as fs } from 'fs';
import path from 'path';
import type { RetentionPruneResult } from './db/drops.js';
import type { IngestBatch } from './durableIngest.js';

const { dbPath, queueDir, config } = workerData;
const port = parentPort!;
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 100');
// The queue receipt and telemetry must survive a power loss together before queue removal.
db.pragma('synchronous = FULL');
let paused = Boolean(workerData.paused);
let busy = false;
let timer: NodeJS.Timeout | null = null;
let pendingPause = false;
const traceInsert = db.prepare(`INSERT INTO traces
 (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes, created_at, telemetry_time)
 SELECT @drop_id, @trace_id, @span_id, @parent_span_id, @service_name, @operation_name, @start_time, @end_time, @duration_ms, @status, @attributes, @created_at, @telemetry_time
 WHERE NOT EXISTS (SELECT 1 FROM traces WHERE drop_id = @drop_id AND trace_id = @trace_id AND span_id IS @span_id)`);
const eventInsert = db.prepare(`INSERT INTO wide_events
 (drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, attributes, created_at, telemetry_time)
 VALUES (@drop_id, @trace_id, @service_name, @operation_type, @field_name, @outcome, @duration_ms, @user_id, @error_count, @rpc_call_count, @attributes, @created_at, @telemetry_time)`);
const getRetention = db.prepare(`SELECT d.id, r.traces_retention_ms, r.events_retention_ms FROM drops d LEFT JOIN drop_retention r ON r.drop_id = d.id WHERE d.id = ?`);
function state() { return db.prepare('SELECT * FROM telemetry_storage_state WHERE id = 1').get(); }
const queueHeads: string[] = [];
async function oldestFile() {
  if (queueHeads.length > 0) return queueHeads[0];
  // Keep only the oldest 100 file names. Scan once per 100 commits, with bounded metadata memory.
  for await (const entry of await fs.opendir(queueDir)) {
    if (!entry.name.endsWith('.json')) continue;
    if (queueHeads.length === 100 && entry.name >= queueHeads[99]) continue;
    queueHeads.push(entry.name); queueHeads.sort();
    if (queueHeads.length > 100) queueHeads.pop();
  }
  return queueHeads[0] ?? null;
}
async function directorySync() {
  const handle = await fs.open(queueDir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
const commit = db.transaction((batch: IngestBatch, filename: string, payloadBytes: number) => {
  if (db.prepare('SELECT id FROM ingest_receipts WHERE id = ?').get(batch.id)) return null;
  const published: { traces: any[]; wide_events: any[]; counts: Array<{ drop_id: number; traces: number; wideEvents: number; errors: number }>; commitCursor: number } = { traces: [], wide_events: [], counts: [], commitCursor: 0 };
  const dropCounts = new Map<number, { drop_id: number; traces: number; wideEvents: number; errors: number }>();
  const requestedLimit = Number(process.env.RAPHAEL_INGEST_BROADCAST_MAX_ITEMS || 500);
  const publishLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(500, requestedLimit) : 500;
  const now = Date.now();
  const retentions = new Map<number, any>();
  const counts = { traces: 0, events: 0, expired_traces: 0, expired_events: 0, missing: 0 };
  for (const [kind, rows] of [['traces', batch.traces], ['events', batch.events]] as const) {
    for (const row of rows) {
      if (!retentions.has(row.drop_id)) retentions.set(row.drop_id, getRetention.get(row.drop_id));
      const retention = retentions.get(row.drop_id);
      if (!retention) { counts.missing++; continue; }
      const duration = kind === 'traces' ? retention.traces_retention_ms : retention.events_retention_ms;
      const timestamp = row.telemetry_time ?? (kind === 'traces' ? (row as any).start_time : batch.received_at);
      if (duration > 0 && timestamp < now - duration) {
        if (kind === 'traces') counts.expired_traces++; else counts.expired_events++;
        continue;
      }
      const record = { ...row, created_at: row.created_at ?? batch.received_at, telemetry_time: timestamp };
      const statement = kind === 'traces' ? traceInsert : eventInsert;
      const inserted = statement.run(record);
      counts[kind] += inserted.changes;
      if (inserted.changes) {
        const delta = dropCounts.get(row.drop_id) ?? { drop_id: row.drop_id, traces: 0, wideEvents: 0, errors: 0 };
        if (kind === 'traces') delta.traces += inserted.changes;
        else {
          delta.wideEvents += inserted.changes;
          if ('outcome' in record && record.outcome === 'error') delta.errors += inserted.changes;
        }
        dropCounts.set(row.drop_id, delta);
      }
      const target = kind === 'traces' ? published.traces : published.wide_events;
      if (inserted.changes && target.length < publishLimit) target.push({ ...record, id: Number(inserted.lastInsertRowid) });
    }
  }
  if (batch.audit && db.prepare('SELECT id FROM api_keys WHERE id = ?').get(batch.audit.api_key_id)) {
    const audit = { ...batch.audit, drop_id: getRetention.get(batch.audit.drop_id) ? batch.audit.drop_id : null };
    db.prepare(`INSERT INTO api_key_usage (api_key_id, drop_id, method, path, status_code, ip_address, user_agent, created_at)
      VALUES (@api_key_id, @drop_id, @method, @path, @status_code, @ip_address, @user_agent, @created_at)`).run({ ...audit, created_at: batch.received_at });
  }
  db.prepare('INSERT INTO ingest_receipts (id, filename, committed_at, payload_bytes) VALUES (?, ?, ?, ?)').run(batch.id, filename, now, payloadBytes);
  db.prepare(`UPDATE telemetry_storage_state SET stored_traces = stored_traces + ?, stored_events = stored_events + ?, expired_traces = expired_traces + ?, expired_events = expired_events + ?, missing_drop_records = missing_drop_records + ?, last_commit_at = ? WHERE id = 1`)
    .run(counts.traces, counts.events, counts.expired_traces, counts.expired_events, counts.missing, now);
  published.counts = [...dropCounts.values()];
  published.commitCursor = (db.prepare('SELECT stored_traces + stored_events AS cursor FROM telemetry_storage_state WHERE id = 1').get() as { cursor: number }).cursor;
  return published;
});
let grant: (() => void) | null = null;
async function acquireWrite() { await new Promise<void>((resolve) => { grant = resolve; port.postMessage({ type: 'write_request' }); }); }
function releaseWrite() { port.postMessage({ type: 'write_done' }); }
function wake(delay = 0) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void drain(); }, delay);
}
async function drain() {
  if (busy || paused) return;
  busy = true;
  let writing = false;
  try {
    // One durable request per turn lets pause messages and continued arrivals interleave.
    const filename = await oldestFile();
    if (!filename) { port.postMessage({ type: 'state', oldest: null, state: state() }); wake(250); return; }
    const file = path.join(queueDir, filename);
    await acquireWrite(); writing = true;
    let serialized: string;
    try { serialized = await fs.readFile(file, 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const receipt = db.prepare('SELECT * FROM ingest_receipts WHERE filename = ?').get(filename) as any;
      if (!receipt) throw new Error(`Queue file disappeared without a committed receipt: ${filename}`);
      await directorySync();
      db.prepare('DELETE FROM ingest_receipts WHERE id = ?').run(receipt.id);
      queueHeads.shift();
      const next = await oldestFile();
      port.postMessage({ type: 'removed', bytes: receipt.payload_bytes, oldest: next ? Number(next.split('-')[0]) : null, state: state() });
      return;
    }
    const disk = await fs.statfs(path.dirname(dbPath));
    if (Number(disk.bavail) * Number(disk.bsize) < config.min_free_disk_bytes + Buffer.byteLength(serialized) * 4) throw new Error('Insufficient database disk space; durable queue retained');
    const batch = JSON.parse(serialized) as IngestBatch;
    if (batch.version !== 1 || !batch.id || !Array.isArray(batch.traces) || !Array.isArray(batch.events)) throw new Error(`Unsupported or corrupt queue file: ${filename}`);
    const commitStarted = performance.now();
    const published = commit.immediate(batch, filename, Buffer.byteLength(serialized));
    const committedAt = Date.now();
    const commitDuration = Math.ceil(performance.now() - commitStarted);
    if (published) db.prepare(`UPDATE telemetry_storage_state SET last_commit_at = ?, last_commit_lag_ms = ?, last_commit_duration_ms = ?, max_commit_duration_ms = MAX(max_commit_duration_ms, ?) WHERE id = 1`)
      .run(committedAt, Math.max(0, committedAt - batch.received_at), commitDuration, commitDuration);
    if (published) port.postMessage({ type: 'broadcast', ...published });
    await fs.unlink(file);
    await directorySync();
    queueHeads.shift();
    // Receipt cleanup follows durable unlink. A crash before unlink/directory sync retains the receipt.
    db.prepare('DELETE FROM ingest_receipts WHERE id = ?').run(batch.id);
    const next = await oldestFile();
    port.postMessage({ type: 'removed', bytes: Buffer.byteLength(serialized), oldest: next ? Number(next.split('-')[0]) : null, state: state() });
  } catch (error) {
    port.postMessage({ type: 'error', error: (error as Error).message });
    wake(1000);
  } finally {
    if (writing) releaseWrite();
    busy = false;
    if (pendingPause) { pendingPause = false; paused = true; port.postMessage({ type: 'done', result: null }); }
    else if (!paused && !timer) wake(0);
  }
}
function pragmaNumber(name: string) { return Number(db.pragma(name, { simple: true })); }
let maintenanceProgress: any = null;
async function maintain(options: { reason?: string; force?: boolean; index_only?: boolean }) {
  const started = Date.now();
  const cutoffTime = started;
  const results: RetentionPruneResult[] = [];
  maintenanceProgress = { success: false, complete: false, reason: options.reason || 'manual', results, phase: 'pruning' };
  if (options.index_only) {
    // Explicitly requested, behind the paused-writer/request gate. Never at
    // startup or as an unexpected addition to scheduled retention.
    // Nonunique preserves historical duplicates and span_id IS NULL semantics.
    const indexStarted = Date.now();
    const indexExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_traces_drop_trace_span'").get();
    if (!indexExists) {
      maintenanceProgress.phase = 'indexing';
      port.postMessage({ type: 'phase', phase: 'indexing' });
      const size = pragmaNumber('page_count') * pragmaNumber('page_size');
      const disk = await fs.statfs(path.dirname(dbPath));
      const temporaryDisk = await fs.statfs(process.env.SQLITE_TMPDIR!);
      // Conservative allowance for the new index, WAL, sort files and queue growth.
      const reserve = config.min_free_disk_bytes + config.queue_max_bytes;
      if (Number(disk.bavail) * Number(disk.bsize) < size * 4 + reserve ||
          Number(temporaryDisk.bavail) * Number(temporaryDisk.bsize) < size * 4 + reserve) {
        throw new Error('Insufficient free disk for trace span index; database and durable queue retained');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_traces_drop_trace_span ON traces(drop_id, trace_id, span_id)');
    }
    const traceSpanIndex = { created: !indexExists, duration_ms: Date.now() - indexStarted };
    maintenanceProgress.trace_span_index = traceSpanIndex;
    maintenanceProgress.phase = 'checkpointing';
    port.postMessage({ type: 'phase', phase: 'checkpointing' });
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as any[];
    if (checkpoint.some((row) => row.busy)) throw new Error('SQLite checkpoint is busy; external connection must release its transaction');
    return { success: true, complete: true, reason: options.reason || 'manual', results,
      index_only: true, trace_span_index: traceSpanIndex, duration_ms: Date.now() - started };
  }
  port.postMessage({ type: 'phase', phase: 'pruning' });
  let complete = true;
  const deadline = started + config.prune_max_runtime_ms;
  const drops = db.prepare('SELECT d.id, r.traces_retention_ms, r.events_retention_ms FROM drops d LEFT JOIN drop_retention r ON r.drop_id = d.id ORDER BY d.id').all() as any[];
  for (const drop of drops) {
    const result = { drop_id: drop.id, traces_deleted: 0, events_deleted: 0, batches: 0, runtime_ms: 0, timed_out: false, busy: false };
    const dropStarted = Date.now();
    for (const [table, field, duration] of [['traces', 'traces_deleted', drop.traces_retention_ms], ['wide_events', 'events_deleted', drop.events_retention_ms]] as const) {
      if (!(duration > 0)) continue;
      const remove = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE drop_id = ? AND COALESCE(telemetry_time, created_at) < ? ORDER BY COALESCE(telemetry_time, created_at) LIMIT ?)`);
      while (true) {
        if (Date.now() >= deadline) { complete = false; result.timed_out = true; break; }
        const changes = remove.run(drop.id, cutoffTime - duration, config.prune_batch_size).changes;
        result[field] += changes; result.batches++;
        if (changes < config.prune_batch_size) break;
      }
    }
    result.runtime_ms = Date.now() - dropStarted; results.push(result);
    if (!complete) break;
  }
  const pruneMs = Date.now() - started;
  maintenanceProgress.prune_ms = pruneMs; maintenanceProgress.phase = 'checkpointing';
  port.postMessage({ type: 'phase', phase: 'checkpointing' });
  const checkpointStart = Date.now();
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as any[];
  if (checkpoint.some((row) => row.busy)) throw new Error('SQLite checkpoint is busy; external connection must release its transaction');
  const checkpointMs = Date.now() - checkpointStart;
  const pageSize = pragmaNumber('page_size');
  const freeBefore = pragmaNumber('freelist_count');
  const sizeBefore = (await fs.stat(dbPath)).size;
  const reclaimable = freeBefore * pageSize;
  const shouldVacuum = complete && reclaimable > config.vacuum_min_reclaimable_bytes && config.vacuum_policy !== 'none';
  let vacuumMs = 0;
  let vacuumSkipped: string | null = null;
  if (shouldVacuum) {
    const disk = await fs.statfs(path.dirname(dbPath));
    // Native VACUUM may need twice the original DB in additional space. Leave capacity for queue growth.
    const required = config.vacuum_policy === 'full' ? sizeBefore * 2 : 0;
    const temporaryDisk = await fs.statfs(process.env.SQLITE_TMPDIR!);
    const temporaryRequired = config.vacuum_policy === 'full' ? sizeBefore + config.min_free_disk_bytes : config.min_free_disk_bytes;
    const reserve = config.min_free_disk_bytes + config.queue_max_bytes;
    if (Number(disk.bavail) * Number(disk.bsize) < required + reserve || Number(temporaryDisk.bavail) * Number(temporaryDisk.bsize) < temporaryRequired) {
      vacuumSkipped = 'insufficient_free_disk';
    } else {
      maintenanceProgress.phase = 'vacuuming';
      port.postMessage({ type: 'phase', phase: 'vacuuming' });
      const vacuumStart = Date.now();
      if (config.vacuum_policy === 'full') db.exec('VACUUM');
      else if (pragmaNumber('auto_vacuum') === 2) db.pragma(`incremental_vacuum(${Math.min(freeBefore, config.incremental_vacuum_max_pages)})`);
      else vacuumSkipped = 'incremental_auto_vacuum_unavailable';
      vacuumMs = Date.now() - vacuumStart;
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } else vacuumSkipped = complete ? 'below_threshold_or_disabled' : 'prune_incomplete';
  const optimizeStart = Date.now();
  db.pragma('optimize');
  return { success: true, complete, reason: options.reason || 'manual', results, prune_ms: pruneMs,
    checkpoint_ms: checkpointMs, vacuum_ms: vacuumMs, optimize_ms: Date.now() - optimizeStart,
    vacuum_policy: config.vacuum_policy, vacuum_skipped: vacuumSkipped, reclaimable_bytes_before: reclaimable,
    freelist_pages_before: freeBefore, freelist_pages_after: pragmaNumber('freelist_count'),
    reclaimed_bytes: Math.max(0, sizeBefore - (await fs.stat(dbPath)).size), duration_ms: Date.now() - started };
}
port.on('message', (message) => {
  if (message.type === 'write_grant') { const resume = grant; grant = null; resume?.(); }
  else if (message.type === 'pause') {
    if (busy) pendingPause = true;
    else { paused = true; port.postMessage({ type: 'done', result: null }); }
  } else if (message.type === 'resume') { paused = false; wake(); }
  else if (message.type === 'wake') { if (!paused) wake(); }
  else if (message.type === 'maintenance') {
    if (!paused || busy) { port.postMessage({ type: 'failed', error: 'Storage must be paused before maintenance' }); return; }
    busy = true;
    void maintain(message.options || {}).then(
      (result) => port.postMessage({ type: 'done', result }),
      (error) => port.postMessage({ type: 'failed', error: (error as Error).message, partial_result: maintenanceProgress })
    ).finally(() => { busy = false; });
  }
});
// A worker restart reconciles removed files which were not yet reported to the parent.
busy = true;
await acquireWrite();
try {
  for (const row of db.prepare('SELECT id, filename, payload_bytes FROM ingest_receipts').all() as Array<{ id: string; filename: string; payload_bytes: number }>) {
    try { await fs.access(path.join(queueDir, row.filename)); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      await directorySync();
      db.prepare('DELETE FROM ingest_receipts WHERE id = ?').run(row.id);

    }
  }
} finally {
  releaseWrite(); busy = false;
  if (pendingPause) { pendingPause = false; paused = true; port.postMessage({ type: 'done', result: null }); }
}
const startupHead = await oldestFile();
port.postMessage({ type: 'state', oldest: startupHead ? Number(startupHead.split('-')[0]) : null, state: state() });
port.postMessage({ type: 'ready' });
wake();
