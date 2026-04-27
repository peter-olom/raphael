import { insertTraceRows, insertWideEventRows, resolveDropId, setDropRetentionMs, type TraceInsertRow, type WideEventInsertRow } from '../src/server/db/sqlite.js';

function numArg(name: string, fallback: number) {
  const flag = `--${name}=`;
  const raw = process.argv.find((a) => a.startsWith(flag))?.slice(flag.length);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function strArg(name: string, fallback: string) {
  const flag = `--${name}=`;
  return process.argv.find((a) => a.startsWith(flag))?.slice(flag.length) ?? fallback;
}

const traceCount = numArg('traces', 2_100_000);
const eventCount = numArg('events', 200_000);
const batchSize = Math.max(1_000, numArg('batch', 10_000));
const dropName = strArg('drop', 'perf');
const dropId = resolveDropId(dropName, true) ?? 1;
setDropRetentionMs(dropId, null, null);

const services = ['api', 'worker', 'checkout', 'billing', 'search', 'gateway', 'inventory', 'email'];
const operations = ['GET /graphql', 'POST /graphql', 'resolve.User', 'resolve.Order', 'job.sync', 'rpc.call'];
const fields = ['user', 'order', 'items', 'checkout', 'payment', 'search', 'inventory'];
const now = Date.now();

function traceId(i: number) {
  return `perf-${Math.floor(i / 5).toString(16).padStart(12, '0')}`;
}

let started = Date.now();
let rows: TraceInsertRow[] = [];
for (let i = 0; i < traceCount; i++) {
  const start = now - (traceCount - i) * 10;
  const duration = 5 + (i % 500);
  rows.push({
    drop_id: dropId,
    trace_id: traceId(i),
    span_id: `span-${i.toString(16)}`,
    parent_span_id: i % 5 === 0 ? null : `span-${(i - 1).toString(16)}`,
    service_name: services[i % services.length],
    operation_name: operations[i % operations.length],
    start_time: start,
    end_time: start + duration,
    duration_ms: duration,
    status: i % 97 === 0 ? 'error' : 'ok',
    attributes: JSON.stringify({ env: 'perf', shard: i % 32, tenant: `tenant-${i % 500}` }),
  });
  if (rows.length >= batchSize) {
    insertTraceRows(rows);
    rows = [];
    if (i && i % 100_000 === 0) console.log(`inserted traces=${i}`);
  }
}
if (rows.length) insertTraceRows(rows);
console.log(`traces done: ${traceCount} in ${Date.now() - started}ms`);

started = Date.now();
let events: WideEventInsertRow[] = [];
for (let i = 0; i < eventCount; i++) {
  const duration = 3 + (i % 1200);
  const outcome = i % 43 === 0 ? 'error' : 'ok';
  events.push({
    drop_id: dropId,
    trace_id: traceId(i * 7),
    service_name: services[i % services.length],
    operation_type: i % 3 === 0 ? 'query' : i % 3 === 1 ? 'mutation' : 'subscription',
    field_name: fields[i % fields.length],
    outcome,
    duration_ms: duration,
    user_id: `user-${i % 50_000}`,
    error_count: outcome === 'error' ? 1 : 0,
    rpc_call_count: i % 12,
    attributes: JSON.stringify({ env: 'perf', field: fields[i % fields.length], tenant: `tenant-${i % 500}`, payload: `sample-${i}` }),
  });
  if (events.length >= batchSize) {
    insertWideEventRows(events);
    events = [];
    if (i && i % 100_000 === 0) console.log(`inserted events=${i}`);
  }
}
if (events.length) insertWideEventRows(events);
console.log(`events done: ${eventCount} in ${Date.now() - started}ms`);
console.log(`seeded drop=${dropName} dropId=${dropId} traces=${traceCount} events=${eventCount}`);
