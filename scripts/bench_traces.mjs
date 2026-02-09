#!/usr/bin/env node
/**
 * Simple ingest benchmark for /v1/traces (OTLP HTTP JSON).
 *
 * Example:
 *   node scripts/bench_traces.mjs --url http://localhost:6274/v1/traces --total 20000 --batch 200 --concurrency 10
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

const url = arg('url', 'http://localhost:6274/v1/traces');
const total = intArg('total', 20000);
const batch = intArg('batch', 200);
const concurrency = Math.max(1, intArg('concurrency', 10));
const drop = arg('drop', '');
const auth = arg('auth', ''); // "Bearer <key>"

if (!globalThis.fetch) {
  console.error('Node 18+ required (global fetch missing).');
  process.exit(1);
}

function spanHex32(i) {
  // Deterministic 32 hex chars
  const base = (BigInt(i) * 0x9e3779b97f4a7c15n) & ((1n << 128n) - 1n);
  return base.toString(16).padStart(32, '0').slice(0, 32);
}

function spanIdHex16(i) {
  const base = (BigInt(i) * 0x517cc1b727220a95n) & ((1n << 64n) - 1n);
  return base.toString(16).padStart(16, '0').slice(0, 16);
}

function makeOtlp(batchStart, batchEnd) {
  const nowNanos = BigInt(Date.now()) * 1_000_000n;
  const spans = [];
  for (let i = batchStart; i < batchEnd; i++) {
    const start = nowNanos + BigInt(i) * 1_000n;
    const end = start + 250_000n;
    spans.push({
      traceId: spanHex32(i),
      spanId: spanIdHex16(i),
      name: 'benchSpan',
      startTimeUnixNano: start.toString(),
      endTimeUnixNano: end.toString(),
      status: { code: 1 },
      attributes: [{ key: 'bench.i', value: { intValue: String(i) } }],
    });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'bench' } }] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

let sent = 0;
let ok = 0;
let fail = 0;

async function worker() {
  while (true) {
    const start = sent;
    if (start >= total) return;
    sent = Math.min(total, sent + batch);
    const end = sent;

    const headers = { 'content-type': 'application/json' };
    if (drop) headers['x-raphael-drop'] = drop;
    if (auth) headers['authorization'] = auth;

    try {
      const body = makeOtlp(start, end);
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.ok) ok += end - start;
      else {
        fail += end - start;
        await res.text().catch(() => {});
      }
    } catch {
      fail += end - start;
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
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
      spans_per_sec: Math.round(rps),
    },
    null,
    2
  )
);

