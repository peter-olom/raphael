import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raphael-page-'));
process.env.RAPHAEL_DB_PATH = path.join(dir, 'test.db');
const db = await import('../src/server/db/sqlite.js');
const dropId = db.resolveDropId('page-test', true) ?? 1;

db.insertTraceRows(Array.from({ length: 12 }, (_, i) => ({
  drop_id: dropId,
  trace_id: `t-${i}`,
  span_id: `s-${i}`,
  parent_span_id: null,
  service_name: i % 2 ? 'api' : 'worker',
  operation_name: `op-${i}`,
  start_time: i,
  end_time: i + 1,
  duration_ms: 1,
  status: i % 3 ? 'ok' : 'error',
  attributes: JSON.stringify({ secret: `needle-${i}` }),
})));

db.insertWideEventRows(Array.from({ length: 12 }, (_, i) => ({
  drop_id: dropId,
  trace_id: `t-${i}`,
  service_name: i % 2 ? 'api' : 'worker',
  operation_type: 'query',
  field_name: `field-${i}`,
  outcome: i % 3 ? 'ok' : 'error',
  duration_ms: 1,
  user_id: `u-${i}`,
  error_count: i % 3 ? 0 : 1,
  rpc_call_count: 1,
  attributes: JSON.stringify({ secret: `needle-${i}` }),
})));

const first = db.getRecentTraces(dropId, 5, 0) as Array<{ id: number; attributes?: string }>;
assert.equal(first.length, 5);
assert.equal(first[0].id > first[4].id, true);
assert.equal(first[0].attributes, undefined, 'list projection should not include trace attributes');
const second = db.getRecentTraces(dropId, 5, 0, first[4].id) as Array<{ id: number }>;
assert.equal(second.length, 5);
assert.equal(second[0].id < first[4].id, true);
assert.equal((db.getRecentTraces(dropId, 9999, 0) as unknown[]).length, 12, 'small tables return all available rows under capped limit');
assert.equal((db.queryTraces(dropId, { where: { service_name: 'api' }, limit: 100 }) as unknown[]).length, 6);
assert.equal((db.searchTraces(dropId, 'needle', 100) as unknown[]).length, 0, 'free-text search should not scan attributes');
assert.equal((db.queryWideEvents(dropId, { where: { outcome: 'error' }, limit: 100 }) as unknown[]).length, 4);
console.log('pagination smoke passed');
