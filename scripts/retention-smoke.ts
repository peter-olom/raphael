import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

function numArg(name: string, fallback: number) {
  const flag = `--${name}=`;
  const raw = process.argv.find((a) => a.startsWith(flag))?.slice(flag.length);
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const traces = numArg('traces', 200_000);
const events = numArg('events', 50_000);
const batch = numArg('batch', 1_000);
const maxMs = numArg('max-ms', 25);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raphael-retention-'));
process.env.RAPHAEL_DB_PATH = path.join(tmp, 'retention.db');
process.env.RAPHAEL_PRUNE_BATCH_SIZE = String(batch);
process.env.RAPHAEL_PRUNE_MAX_RUNTIME_MS = String(maxMs);

const dbm = await import('../src/server/db/sqlite.js');
const dropId = dbm.resolveDropId('retention-smoke', true) ?? 1;
const secondDropId = dbm.resolveDropId('retention-smoke-second', true) ?? 2;
const now = Date.now();
const oldCreatedAt = now - 7 * 24 * 60 * 60 * 1000;
const newCreatedAt = now;

dbm.setDropRetentionMs(dropId, 60 * 60 * 1000, 60 * 60 * 1000);
dbm.setDropRetentionMs(secondDropId, 60 * 60 * 1000, 60 * 60 * 1000);

for (let i = 0; i < traces; i += 10_000) {
  const end = Math.min(traces, i + 10_000);
  dbm.insertTraceRows(Array.from({ length: end - i }, (_, j) => {
    const n = i + j;
    return {
      drop_id: dropId,
      trace_id: `ret-trace-${Math.floor(n / 4)}`,
      span_id: `span-${n}`,
      parent_span_id: null,
      service_name: 'retention',
      operation_name: 'old-trace',
      start_time: oldCreatedAt + n,
      end_time: oldCreatedAt + n + 1,
      duration_ms: 1,
      status: 'ok',
      attributes: '{}',
    };
  }));
}

for (let i = 0; i < events; i += 10_000) {
  const end = Math.min(events, i + 10_000);
  dbm.insertWideEventRows(Array.from({ length: end - i }, (_, j) => {
    const n = i + j;
    return {
      drop_id: dropId,
      trace_id: `ret-trace-${Math.floor(n / 4)}`,
      service_name: 'retention',
      operation_type: 'query',
      field_name: 'oldEvent',
      outcome: 'ok',
      duration_ms: 1,
      user_id: `u-${n}`,
      error_count: 0,
      rpc_call_count: 1,
      attributes: '{}',
    };
  }));
}

const raw = new Database(process.env.RAPHAEL_DB_PATH!);
raw.prepare('UPDATE traces SET created_at = ? WHERE drop_id = ?').run(oldCreatedAt, dropId);
raw.prepare('UPDATE wide_events SET created_at = ? WHERE drop_id = ?').run(oldCreatedAt, dropId);
// Keep a few new rows that must not be pruned.
raw.prepare('UPDATE traces SET created_at = ? WHERE drop_id = ? AND id IN (SELECT id FROM traces WHERE drop_id = ? ORDER BY id DESC LIMIT 10)').run(newCreatedAt, dropId, dropId);
raw.prepare('UPDATE wide_events SET created_at = ? WHERE drop_id = ? AND id IN (SELECT id FROM wide_events WHERE drop_id = ? ORDER BY id DESC LIMIT 10)').run(newCreatedAt, dropId, dropId);

const tracePlan = raw.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM traces WHERE drop_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(dropId, now, batch);
const eventPlan = raw.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM wide_events WHERE drop_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(dropId, now, batch);
const planText = JSON.stringify([...tracePlan, ...eventPlan]);
assert.match(planText, /idx_traces_drop_created/, 'trace retention predicate should use drop_id/created_at index');
assert.match(planText, /idx_events_drop_created/, 'event retention predicate should use drop_id/created_at index');

const beforeTraces = (raw.prepare('SELECT COUNT(*) AS n FROM traces WHERE drop_id = ?').get(dropId) as { n: number }).n;
const beforeEvents = (raw.prepare('SELECT COUNT(*) AS n FROM wide_events WHERE drop_id = ?').get(dropId) as { n: number }).n;
const started = performance.now();
const result = dbm.pruneByRetention(dropId, now)[0];
const elapsed = performance.now() - started;
const afterTraces = (raw.prepare('SELECT COUNT(*) AS n FROM traces WHERE drop_id = ?').get(dropId) as { n: number }).n;
const afterEvents = (raw.prepare('SELECT COUNT(*) AS n FROM wide_events WHERE drop_id = ?').get(dropId) as { n: number }).n;
const newTraceSurvivors = (raw.prepare('SELECT COUNT(*) AS n FROM traces WHERE drop_id = ? AND created_at = ?').get(dropId, newCreatedAt) as { n: number }).n;
const newEventSurvivors = (raw.prepare('SELECT COUNT(*) AS n FROM wide_events WHERE drop_id = ? AND created_at = ?').get(dropId, newCreatedAt) as { n: number }).n;
const walCheckpoint = raw.pragma('wal_checkpoint(PASSIVE)') as unknown;
const freelist = raw.pragma('freelist_count', { simple: true }) as number;
raw.close();

assert.ok(result, 'prune should return one result');
assert.ok(result.batches > 0, 'prune should delete in at least one batch');
assert.ok(result.traces_deleted + result.events_deleted > 0, 'prune should delete old rows');
assert.ok(result.traces_deleted > 0, 'trace cleanup should get prune time');
assert.ok(result.events_deleted > 0, 'wide-event cleanup should get prune time even with trace backlog');
assert.ok(result.traces_deleted + result.events_deleted <= result.batches * Math.max(100, Math.min(batch, 50_000)), 'deleted rows should be bounded by recorded batches');
assert.equal(newTraceSurvivors, 10, 'new trace rows must not be pruned');
assert.equal(newEventSurvivors, 10, 'new event rows must not be pruned');

const rotatedResults = dbm.pruneByRetention(undefined, now, {
  startAfterDropId: dropId,
});
assert.equal(
  rotatedResults[0]?.drop_id,
  secondDropId,
  'automatic retention should resume with the drop after the last attempted drop'
);

console.log(JSON.stringify({
  seeded: { traces: beforeTraces, events: beforeEvents },
  result,
  elapsed_ms: Number(elapsed.toFixed(1)),
  remaining: { traces: afterTraces, events: afterEvents },
  new_survivors: { traces: newTraceSurvivors, events: newEventSurvivors },
  index_plans: { traces: tracePlan, events: eventPlan },
  freelist_count: freelist,
  wal_checkpoint_passive: walCheckpoint,
}, null, 2));
