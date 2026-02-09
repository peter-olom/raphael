#!/usr/bin/env node
/**
 * Simple ingest benchmark for /v1/events.
 *
 * Example:
 *   node scripts/bench_events.mjs --url http://localhost:6274/v1/events --total 50000 --batch 200 --concurrency 10
 */

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith('--')) return fallback;
  return v;
}

function intArg(name, fallback) {
  const v = Number(arg(name, String(fallback)));
  return Number.isFinite(v) ? Math.floor(v) : fallback;
}

const url = arg('url', 'http://localhost:6274/v1/events');
const total = intArg('total', 20000);
const batch = intArg('batch', 200);
const concurrency = Math.max(1, intArg('concurrency', 10));
const drop = arg('drop', '');
const auth = arg('auth', ''); // "Bearer <key>"

if (!globalThis.fetch) {
  console.error('Node 18+ required (global fetch missing).');
  process.exit(1);
}

function makeEvent(i) {
  return {
    trace_id: `bench-${Math.floor(i / 10)}-${i}`,
    'service.name': 'bench',
    'graphql.operation_type': 'query',
    'graphql.field_name': 'benchEvent',
    outcome: 'success',
    'duration.total_ms': i % 1000,
    'user.id': `user-${i % 100}`,
    error_count: 0,
    'count.rpc_calls': i % 5,
    bench: { i },
  };
}

let sent = 0;
let ok = 0;
let fail = 0;

async function worker(id) {
  while (true) {
    const start = sent;
    if (start >= total) return;
    sent = Math.min(total, sent + batch);
    const end = sent;

    const payload = [];
    for (let i = start; i < end; i++) payload.push(makeEvent(i));

    const headers = { 'content-type': 'application/json' };
    if (drop) headers['x-raphael-drop'] = drop;
    if (auth) headers['authorization'] = auth;

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.ok) ok += payload.length;
      else {
        fail += payload.length;
        await res.text().catch(() => {});
      }
    } catch {
      fail += payload.length;
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const dt = (Date.now() - t0) / 1000;

const rps = ok / dt;
console.log(
  JSON.stringify(
    {
      url,
      total,
      batch,
      concurrency,
      ok,
      fail,
      seconds: dt,
      events_per_sec: Math.round(rps),
    },
    null,
    2
  )
);

