import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

const tempDir = mkdtempSync(path.join(tmpdir(), 'raphael-test-'));

process.env.RAPHAEL_DB_PATH = path.join(tempDir, 'raphael.db');
process.env.RAPHAEL_AUTH_ENABLED = 'false';
process.env.NODE_ENV = 'production';

const sqlite = await import('../src/server/db/sqlite.js');
const auth = await import('../src/server/auth.js');
const proxy = await import('../src/server/proxy.js');
const rateLimit = await import('../src/server/ingestRateLimit.js');

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function responseStub() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

test('production admin operations are denied when auth is off and no override is set', () => {
  delete process.env.RAPHAEL_ALLOW_UNAUTH_ADMIN;
  const res = responseStub();
  const req = { ip: '203.0.113.10', socket: { remoteAddress: '203.0.113.10' } };

  assert.equal(auth.requireAdmin(req as any, res as any), false);
  assert.equal(res.statusCode, 403);
});

test('production admin operations are denied for proxied loopback requests without explicit override', () => {
  delete process.env.RAPHAEL_ALLOW_UNAUTH_ADMIN;
  const res = responseStub();
  const req = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };

  assert.equal(auth.requireAdmin(req as any, res as any), false);
  assert.equal(res.statusCode, 403);
});

test('explicit override allows unauthenticated admin mode for controlled deployments', () => {
  process.env.RAPHAEL_ALLOW_UNAUTH_ADMIN = 'true';
  const res = responseStub();
  const req = { ip: '203.0.113.10', socket: { remoteAddress: '203.0.113.10' } };

  assert.equal(auth.requireAdmin(req as any, res as any), true);
  assert.equal(res.statusCode, 200);
  delete process.env.RAPHAEL_ALLOW_UNAUTH_ADMIN;
});

test('production auth requires an explicit admin bootstrap path', () => {
  process.env.RAPHAEL_AUTH_ENABLED = 'true';
  process.env.NODE_ENV = 'production';
  delete process.env.RAPHAEL_ADMIN_EMAIL;
  delete process.env.RAPHAEL_ALLOW_FIRST_USER_ADMIN;

  assert.throws(
    () => auth.validateAuthBootstrapConfig(),
    /Production auth requires an admin bootstrap path/
  );

  process.env.RAPHAEL_ADMIN_EMAIL = 'admin@example.com';
  assert.doesNotThrow(() => auth.validateAuthBootstrapConfig());

  process.env.RAPHAEL_AUTH_ENABLED = 'false';
  delete process.env.RAPHAEL_ADMIN_EMAIL;
});

test('OAuth allowlist enforcement is disabled in hybrid auth mode', () => {
  const childDir = mkdtempSync(path.join(tmpdir(), 'raphael-auth-mode-test-'));
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        "const auth = await import('./src/server/auth.ts'); console.log(auth.isOauthAllowlistEnforced() ? 'yes' : 'no');",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RAPHAEL_DB_PATH: path.join(childDir, 'raphael.db'),
          RAPHAEL_AUTH_ENABLED: 'true',
          RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED: 'true',
          NODE_ENV: 'production',
          RAPHAEL_ADMIN_EMAIL: 'admin@example.com',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
        },
      }
    )
      .toString()
      .trim();
    assert.equal(output, 'no');
  } finally {
    rmSync(childDir, { recursive: true, force: true });
  }
});


test('duplicate span ingestion is ignored per drop, trace, and span', () => {
  sqlite.insertTraceRow(
    sqlite.DEFAULT_DROP_ID,
    'trace-1',
    'span-1',
    null,
    'api',
    'GET /health',
    1,
    2,
    1,
    'ok',
    '{}'
  );
  sqlite.insertTraceRow(
    sqlite.DEFAULT_DROP_ID,
    'trace-1',
    'span-1',
    null,
    'api',
    'GET /health',
    1,
    2,
    1,
    'ok',
    '{}'
  );

  const rows = sqlite.getTraceById(sqlite.DEFAULT_DROP_ID, 'trace-1') as unknown[];
  assert.equal(rows.length, 1);
});

test('duplicate span maintenance advances in bounded windows', () => {
  const db = new Database(sqlite.DB_PATH);
  try {
    db.prepare(`
      INSERT INTO traces (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sqlite.DEFAULT_DROP_ID, 'trace-maint', 'span-maint', null, 'api', 'GET /maintenance', 1, 2, 1, 'ok', '{}');
    db.prepare(`
      INSERT INTO traces (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sqlite.DEFAULT_DROP_ID, 'trace-maint', 'span-maint', null, 'api', 'GET /maintenance', 1, 2, 1, 'ok', '{}');
  } finally {
    db.close();
  }

  const before = sqlite.getTraceById(sqlite.DEFAULT_DROP_ID, 'trace-maint') as unknown[];
  assert.equal(before.length, 2);

  const result = sqlite.dedupeTraceSpans({ id_window_size: 100, max_runtime_ms: 1000, start_after_id: 0 });
  assert.equal(result.traces_deleted, 1);
  assert.ok(result.cursor_end_id > 0);

  const after = sqlite.getTraceById(sqlite.DEFAULT_DROP_ID, 'trace-maint') as unknown[];
  assert.equal(after.length, 1);
});

test('empty searches return no rows instead of broad scans', () => {
  assert.deepEqual(sqlite.searchTraces(sqlite.DEFAULT_DROP_ID, ''), []);
  assert.deepEqual(sqlite.searchWideEvents(sqlite.DEFAULT_DROP_ID, '   '), []);
});

test('structured query search does not scan attributes unless explicitly enabled', () => {
  delete process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED;
  sqlite.insertWideEventRow(
    sqlite.DEFAULT_DROP_ID,
    'trace-attrs',
    'api',
    'query',
    'field',
    'ok',
    1,
    null,
    0,
    0,
    JSON.stringify({ hidden: 'needle-only-in-attributes' })
  );

  assert.deepEqual(sqlite.queryWideEvents(sqlite.DEFAULT_DROP_ID, { q: 'needle-only-in-attributes' }), []);

  process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED = 'true';
  assert.equal(sqlite.queryWideEvents(sqlite.DEFAULT_DROP_ID, { q: 'needle-only-in-attributes' }).length, 1);
  delete process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED;
});

test('ingest rate limiter rejects requests over the item budget', () => {
  rateLimit.resetIngestRateLimitForTests();
  process.env.RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE = '2';
  process.env.RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE = '100';
  process.env.RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER = '1';

  const req = { ip: '198.51.100.10', socket: { remoteAddress: '198.51.100.10' } };
  const first = responseStub();
  const second = responseStub();

  assert.equal(rateLimit.checkIngestRateLimit(req as any, first as any, 2), true);
  assert.equal(rateLimit.checkIngestRateLimit(req as any, second as any, 1), false);
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers['Retry-After'], '30');

  delete process.env.RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE;
  delete process.env.RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE;
  delete process.env.RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER;
  rateLimit.resetIngestRateLimitForTests();
});

test('ingest rate limiter separates proxied clients when loopback proxy trust is enabled', async () => {
  rateLimit.resetIngestRateLimitForTests();
  process.env.RAPHAEL_TRUST_PROXY = 'loopback';
  process.env.RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE = '100';
  process.env.RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE = '1';
  process.env.RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER = '1';

  const app = express();
  proxy.configureTrustProxy(app);
  app.post('/ingest', (req, res) => {
    if (rateLimit.checkIngestRateLimit(req, res, 1)) {
      res.json({ ok: true, ip: req.ip });
    }
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    const url = `http://127.0.0.1:${address.port}/ingest`;
    const request = (forwardedFor: string) =>
      fetch(url, { method: 'POST', headers: { 'x-forwarded-for': forwardedFor } });

    const first = await request('198.51.100.10');
    const second = await request('198.51.100.10');
    const third = await request('198.51.100.11');

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(third.status, 200);
    assert.equal((await first.json() as { ip: string }).ip, '198.51.100.10');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    delete process.env.RAPHAEL_TRUST_PROXY;
    delete process.env.RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE;
    delete process.env.RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE;
    delete process.env.RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER;
    rateLimit.resetIngestRateLimitForTests();
  }
});
