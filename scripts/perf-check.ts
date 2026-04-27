const base = process.env.RAPHAEL_BASE_URL || 'http://localhost:6274';
const drop = process.env.RAPHAEL_PERF_DROP || 'perf';

async function timed(path: string, init?: RequestInit) {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, init);
  const body = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${body.slice(0, 200)}`);
  let count = 0;
  try {
    const json = JSON.parse(body);
    count = Array.isArray(json) ? json.length : Array.isArray(json.items) ? json.items.length : 1;
  } catch {}
  console.log(`${path} ${ms.toFixed(1)}ms rows=${count} bytes=${body.length}`);
}

await timed(`/api/stats?drop=${encodeURIComponent(drop)}`);
await timed(`/api/traces?drop=${encodeURIComponent(drop)}&limit=100&envelope=1`);
await timed(`/api/events?drop=${encodeURIComponent(drop)}&limit=100&envelope=1`);
await timed(`/api/search/traces?drop=${encodeURIComponent(drop)}&q=checkout&limit=100`);
await timed(`/api/search/events?drop=${encodeURIComponent(drop)}&q=payment&limit=100`);
await timed(`/v1/query/traces`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ drop, where: { service_name: 'api' }, limit: 100 }),
});
await timed(`/v1/query/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ drop, where: { outcome: 'error' }, limit: 100 }),
});
