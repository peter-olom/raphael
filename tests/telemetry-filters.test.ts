import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const directory = mkdtempSync(path.join(tmpdir(), 'raphael-filters-'));
process.env.RAPHAEL_DB_PATH = path.join(directory, 'test.db');
const { db } = await import('../src/server/db/core.js');
await import('../src/server/db/sqlite.js');
const { queryTelemetry, getRecentWideEvents } = await import('../src/server/db/telemetry.js');
const insert = db.prepare('INSERT INTO wide_events (drop_id, service_name, outcome, attributes) VALUES (1, ?, ?, ?)');
for (let i = 0; i < 240; i++) insert.run(i % 2 ? 'api' : 'worker', i % 3 ? 'success' : 'error', JSON.stringify({ 'custom.code': i === 1 ? 'needle' : 'other', nested: { flag: false } }));
test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
test('filters find matches beyond the initial page and combine search with AND/OR semantics', () => {
  const rows = queryTelemetry(1, 'events', 100, null, '', { 'custom.code': { op: 'in', values: ['needle'] } }) as any[];
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 2);
  const filters = { service_name: { op: 'in', values: ['api', 'worker'] }, outcome: { op: 'in', values: ['error'] } };
  const first = queryTelemetry(1, 'events', 10, null, 'api', filters) as any[];
  assert.equal(first.length, 10);
  assert.ok(first.every(row => row.service_name === 'api' && row.outcome === 'error'));
  const second = queryTelemetry(1, 'events', 10, first.at(-1).id, 'api', filters) as any[];
  assert.ok(second.every(row => row.id < first.at(-1).id));
});
test('contains is literal, nested boolean attributes work, and invalid filters are rejected', () => {
  assert.equal(queryTelemetry(1, 'events', 100, null, '', { service_name: { op: 'contains', values: ['API'] } }).length, 100);
  assert.equal(queryTelemetry(1, 'events', 100, null, '', { service_name: { op: 'contains', values: ['%'] } }).length, 0);
  assert.equal(queryTelemetry(1, 'events', 100, null, '', { 'nested.flag': { op: 'in', values: ['false'] } }).length, 100);
  assert.throws(() => queryTelemetry(1, 'events', 100, null, '', { 'x); DROP TABLE traces;': { op: 'in', values: ['x'] } }));
  assert.throws(() => queryTelemetry(1, 'events', 100, null, '', { x: { op: 'in', values: [null] } }));
});
test('dashboard sample includes attributes while list rows stay lightweight', () => {
  assert.ok('attributes' in (getRecentWideEvents(1, 100, 0, null, 20000, true)[0] as object));
  assert.ok(!('attributes' in (getRecentWideEvents(1, 100)[0] as object)));
});

test('traces filter across pages and cannot cross drop boundaries', () => {
  db.prepare("INSERT INTO traces (drop_id, trace_id, service_name, operation_name, start_time, status, attributes) VALUES (1, 'trace-test', 'api', 'checkout', 1, 'error', '{}')").run();
  assert.equal(queryTelemetry(1, 'traces', 100, null, 'checkout', { status: { op: 'in', values: ['error'] } }).length, 1);
  assert.equal(queryTelemetry(999, 'traces', 100, null, 'checkout', {}).length, 0);
});
test('dashboard sample can exceed the normal list limit', () => {
  db.transaction(() => { for (let i = 0; i < 2200; i++) insert.run('sample', 'success', '{}'); })();
  assert.equal(getRecentWideEvents(1, 3000, 0, null, 20000, true).length, 2440);
  assert.equal(getRecentWideEvents(1, 3000).length, 2000);
});
