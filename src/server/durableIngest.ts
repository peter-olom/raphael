import { promises as fs, existsSync, realpathSync } from 'fs';
import { acquireStorageWrite, releaseStorageWrite } from './maintenanceGate.js';
import { broadcast, hasSubscribers } from './websocket.js';
import path from 'path';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import { DB_PATH } from './paths.js';
import { maintenanceConfig } from './maintenanceConfig.js';
import type { TraceInsertRow, WideEventInsertRow } from './db/telemetry.js';

export const QUEUE_DIR = path.resolve(process.env.RAPHAEL_INGEST_QUEUE_DIR || `${realpathSync(DB_PATH)}.ingest`);
export type IngestBatch = {
  version: 1;
  id: string;
  received_at: number;
  traces: TraceInsertRow[];
  events: WideEventInsertRow[];
  audit?: { api_key_id: number; drop_id: number; method: string; path: string; status_code: number; ip_address: string | null; user_agent: string | null };
};
export class IngestUnavailable extends Error {}
let worker: Worker | null = null;
let startupReady: (() => void) | null = null;
let startupFailed: ((error: Error) => void) | null = null;
let ready = false;
let stopping = false;
let bytes = 0;
let depth = 0;
let reserved = 0;
let oldest: number | null = null;
let lastError: string | null = null;
let storageState: unknown = null;
let runningRequest: { resolve: (value: any) => void; reject: (error: Error) => void } | null = null;
let pauseRequested = false;
let phaseListener: ((phase: string) => void) | null = null;
export function onStoragePhase(listener: (phase: string) => void) { phaseListener = listener; }
let pendingSyncs = 0;
let admission: Promise<void> = Promise.resolve();
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function startDurableIngest() {
  const createdParents: string[] = [];
  for (let directory = QUEUE_DIR; !existsSync(directory); directory = path.dirname(directory)) createdParents.push(path.dirname(directory));
  await fs.mkdir(QUEUE_DIR, { recursive: true, mode: 0o700 });
  // Persist each newly created directory entry as well as the request files it will contain.
  for (const parent of createdParents) await syncDirectory(parent);
  const manifestPath = path.join(QUEUE_DIR, '.queue-owner');
  const databasePath = await fs.realpath(DB_PATH);
  const manifest = JSON.stringify({ version: 1, database_path: databasePath });
  try {
    const handle = await fs.open(manifestPath, 'wx', 0o600);
    try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(QUEUE_DIR);
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    if (await fs.readFile(manifestPath, 'utf8') !== manifest) throw new Error('Ingestion queue belongs to a different database; use a dedicated queue directory');
  }
  await scanQueueMetadata(true);
  await new Promise<void>((resolve, reject) => { startupReady = resolve; startupFailed = reject; launchWorker(); });
  ready = true;
}
async function scanQueueMetadata(removeTemps = false) {
  let nextBytes = 0, nextDepth = 0;
  let nextOldest: number | null = null;
  for await (const entry of await fs.opendir(QUEUE_DIR)) {
    if (entry.name.endsWith('.tmp')) {
      if (removeTemps) await fs.unlink(path.join(QUEUE_DIR, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const stat = await fs.stat(path.join(QUEUE_DIR, entry.name));
    nextBytes += stat.size; nextDepth++;
    const receivedAt = Number(entry.name.split('-')[0]);
    if (Number.isFinite(receivedAt)) nextOldest = nextOldest === null ? receivedAt : Math.min(nextOldest, receivedAt);
  }
  bytes = nextBytes; depth = nextDepth; oldest = nextOldest;
  await syncDirectory(QUEUE_DIR);
}
async function recoverWorker() {
  if (stopping || worker) return;
  try {
    const deadline = Date.now() + 5000;
    while (pendingSyncs > 0) {
      if (Date.now() >= deadline) throw new Error('Waiting for outstanding queue persistence before storage recovery');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await scanQueueMetadata(true);
    launchWorker();
  } catch (error) {
    lastError = (error as Error).message;
    setTimeout(() => { void recoverWorker(); }, 1000).unref();
  }
}
function launchWorker() {
  const compiled = new URL('./storageWorker.js', import.meta.url);
  const workerData = { dbPath: DB_PATH, queueDir: QUEUE_DIR, config: maintenanceConfig, paused: pauseRequested };
  worker = existsSync(compiled)
    ? new Worker(compiled, { workerData })
    : new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(new URL('./storageWorker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`, { eval: true, workerData });
  worker.on('message', (message) => {
    if (message.type === 'ready') { ready = true; startupReady?.(); startupReady = null; startupFailed = null; }
    else if (message.type === 'write_request') {
      const current = worker;
      void acquireStorageWrite().then(() => { if (worker === current) current?.postMessage({ type: 'write_grant' }); else releaseStorageWrite(); });
    } else if (message.type === 'write_done') { releaseStorageWrite(); }
    else if (message.type === 'phase') { phaseListener?.(message.phase); }
    else if (message.type === 'removed') {
      lastError = null;
      bytes = Math.max(0, bytes - message.bytes); depth = Math.max(0, depth - 1);
      oldest = message.oldest;
      storageState = message.state;
    } else if (message.type === 'broadcast') {
      for (const delta of message.counts || []) {
        if (hasSubscribers(delta.drop_id)) broadcast({ type: 'stats_delta', ...delta, commitCursor: message.commitCursor }, delta.drop_id);
      }
      const requestedBatch = Number(process.env.RAPHAEL_INGEST_BROADCAST_BATCH_SIZE || 200);
      const batchSize = Number.isSafeInteger(requestedBatch) && requestedBatch > 0 ? Math.min(5000, requestedBatch) : 200;
      for (const kind of ['traces', 'wide_events']) {
        const groups = new Map<number, any[]>();
        for (const item of message[kind] || []) {
          if (!hasSubscribers(item.drop_id)) continue;
          const group = groups.get(item.drop_id) || [];
          group.push(item); groups.set(item.drop_id, group);
        }
        for (const [dropId, records] of groups) {
          for (let offset = 0; offset < records.length; offset += batchSize) {
            broadcast({ type: kind, drop_id: dropId, commitCursor: message.commitCursor, data: records.slice(offset, offset + batchSize) }, dropId);
          }
        }
      }
    } else if (message.type === 'state') {
      oldest = message.oldest; storageState = message.state;
    } else if (message.type === 'done') {
      runningRequest?.resolve(message.result); runningRequest = null;
    } else if (message.type === 'failed') {
      lastError = message.error;
      const failure = Object.assign(new Error(message.error), { partial_result: message.partial_result });
      runningRequest?.reject(failure); runningRequest = null;
    } else if (message.type === 'error') { lastError = message.error; }
  });
  worker.on('error', (error) => { lastError = error.message; startupFailed?.(error); startupFailed = null; startupReady = null; });
  worker.on('exit', (code) => {
    releaseStorageWrite();
    ready = false;
    worker = null;
    runningRequest?.reject(new Error(`Storage worker exited (${code})`)); runningRequest = null;
    if (!stopping) {
      lastError = `Storage worker exited (${code}); durable queue retained`;
      // Maintenance owner decides when to reopen the gate; never automatically restart an expensive operation.
      setTimeout(() => { void recoverWorker(); }, 1000).unref();
    }
  });
}
export async function enqueueTelemetry(input: Omit<IngestBatch, 'version' | 'id' | 'received_at'>, receivedAt = Date.now()) {
  if (!ready || stopping) throw new IngestUnavailable('Durable ingestion is not ready');
  const batch: IngestBatch = { version: 1, id: randomUUID(), received_at: receivedAt, ...input };
  // Check a bounded row at a time before allocating the complete serialized request.
  let estimated = Buffer.byteLength(JSON.stringify({ ...batch, traces: [], events: [] }));
  for (const rows of [batch.traces, batch.events]) {
    for (const row of rows) {
      estimated += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (estimated + reserved > maintenanceConfig.queue_max_inflight_bytes) throw new IngestUnavailable('Ingestion persistence is busy');
    }
  }
  const serialized = JSON.stringify(batch);
  const size = Buffer.byteLength(serialized);
  if (size + reserved > maintenanceConfig.queue_max_inflight_bytes) throw new IngestUnavailable('Ingestion persistence is busy');
  reserved += size;
  pendingSyncs++;
  const filename = `${String(receivedAt).padStart(13, '0')}-${batch.id}.json`;
  const final = path.join(QUEUE_DIR, filename);
  const temp = `${final}.tmp`;
  let admitted = false;
  let renamed = false;
  // Reserve disk/queue space serially. File I/O runs asynchronously outside this short section.
  const prior = admission;
  let release!: () => void;
  admission = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prior;
    try {
      if (depth >= maintenanceConfig.queue_max_items) throw new IngestUnavailable('Durable ingestion queue item limit reached');
      if (bytes + size > maintenanceConfig.queue_max_bytes) throw new IngestUnavailable('Durable ingestion queue is full');
      const disk = await fs.statfs(QUEUE_DIR);
      const databaseDisk = await fs.statfs(path.dirname(DB_PATH));
      if (Number(databaseDisk.bavail) * Number(databaseDisk.bsize) < maintenanceConfig.min_free_disk_bytes) throw new IngestUnavailable('Insufficient database disk space for ingestion');
      if (Number(disk.bavail) * Number(disk.bsize) - reserved < maintenanceConfig.min_free_disk_bytes) throw new IngestUnavailable('Insufficient free disk for durable ingestion');
      bytes += size; depth++; admitted = true;
      oldest = oldest === null ? receivedAt : Math.min(oldest, receivedAt);
    } finally { release(); }
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, final); renamed = true;
    await syncDirectory(QUEUE_DIR);
    worker?.postMessage({ type: 'wake' });
    return batch.id;
  } catch (error) {
    if (!renamed) {
      await fs.unlink(temp).catch(() => {});
      if (admitted) { bytes -= size; depth--; }
    }
    // A rename followed by a failed directory sync has uncertain persistence; keep the record for recovery.
    throw new IngestUnavailable((error as Error).message || 'Could not persist telemetry');
  } finally { reserved -= size; pendingSyncs--; }
}
export function storageCommand(type: 'pause' | 'resume' | 'maintenance', options?: unknown) {
  if (type === 'pause') pauseRequested = true;
  if (type === 'resume') { pauseRequested = false; worker?.postMessage({ type }); return Promise.resolve(null); }
  if (!worker) return Promise.reject(new Error('Storage worker unavailable'));
  if (runningRequest) return Promise.reject(new Error('Storage operation already in progress'));
  return new Promise<any>((resolve, reject) => {
    runningRequest = { resolve, reject }; worker!.postMessage({ type, options });
  });
}
export function getDurableIngestStatus() {
  return { ready, queue_depth: depth, queue_bytes: bytes, pending_persistence: pendingSyncs, inflight_bytes: reserved,
    oldest_received_at: oldest, oldest_queue_age_ms: oldest === null ? 0 : Math.max(0, Date.now() - oldest),
    storage_lag_ms: (storageState as any)?.last_commit_lag_ms ?? null,
    draining_paused: pauseRequested, worker_available: Boolean(worker), last_error: lastError,
    queue_max_bytes: maintenanceConfig.queue_max_bytes, storage: storageState };
}
export async function stopDurableIngest() {
  stopping = true; ready = false;
  await worker?.terminate();
}
