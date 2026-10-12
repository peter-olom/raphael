import type { Request, Response, NextFunction } from 'express';

let closed = false;
let active = 0;
let writerPending = false;
let grantWriter: (() => void) | null = null;
const waiters = new Set<() => void>();
const requestWaiters = new Set<() => void>();
export function maintenanceActive() { return closed; }
function notifyIdle() {
  if (active !== 0) return;
  for (const resolve of waiters) resolve();
  grantWriter?.();
}
export function beginDatabaseOperation(allowPending = false): (() => void) | null {
  if (closed || (writerPending && !allowPending)) return null;
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; notifyIdle(); } };
}
// The storage worker must hold this lease for every write, including replay receipts.
export async function acquireStorageWrite() {
  if (writerPending) throw new Error('Another storage write is already pending');
  writerPending = true;
  if (active === 0) return;
  await new Promise<void>((resolve) => { grantWriter = () => { grantWriter = null; resolve(); }; });
}
export function releaseStorageWrite() {
  grantWriter = null; writerPending = false;
  for (const resume of requestWaiters) resume();
}
async function waitForStorageWrite() {
  if (!writerPending) return true;
  if (requestWaiters.size >= 100) return false;
  return new Promise<boolean>((resolve) => {
    const resume = () => { clearTimeout(timer); requestWaiters.delete(resume); resolve(true); };
    const timer = setTimeout(() => { requestWaiters.delete(resume); resolve(false); }, 1000);
    requestWaiters.add(resume);
  });
}
export async function closeDatabaseGate(timeoutMs = 30_000) {
  closed = true;
  if (active === 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(() => { waiters.delete(done); reject(new Error('Timed out waiting for in-flight database requests')); }, timeoutMs);
    waiters.add(done);
  });
}
export function openDatabaseGate() { closed = false; }
export function retryMaintenance(res: Response, message = 'Database maintenance in progress; retry shortly') {
  res.setHeader('Retry-After', '2'); res.status(503).json({ error: message, retryable: true });
}
export function isIngestRequest(req: Request) {
  return req.method === 'POST' && ['/v1/traces', '/v1/events', '/v1/logs'].includes(req.path);
}
export async function databaseRequestGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/v1')) return next();
  if (!closed && !await waitForStorageWrite()) return retryMaintenance(res, 'Database write capacity busy; retry shortly');
  if (res.destroyed) return;
  if (closed) {
    if (isIngestRequest(req) || req.path === '/api/admin/retention') return next();
    return retryMaintenance(res);
  }
  const release = beginDatabaseOperation();
  if (!release) return retryMaintenance(res, 'Database write capacity busy; retry shortly');
  // Finish listeners (including usage audit) run before the barrier resumes.
  const finish = () => setImmediate(release);
  res.once('finish', finish); res.once('close', finish);
  next();
}
