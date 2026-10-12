import { promises as fs, readFileSync, realpathSync } from 'fs';
import { maintenanceConfig } from './maintenanceConfig.js';
import path from 'path';
import { DB_PATH } from './paths.js';
import { closeDatabaseGate, openDatabaseGate } from './maintenanceGate.js';
import { captureMaintenanceSnapshot, clearMaintenanceSnapshot } from './maintenanceSnapshot.js';
import { getDurableIngestStatus, storageCommand, onStoragePhase } from './durableIngest.js';

const statePath = `${realpathSync(DB_PATH)}.maintenance.json`;
let saved: any = {};
try { saved = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
let timer: NodeJS.Timeout | null = null;
let running = false;
let phase = 'idle';
let nextRunAt: number | null = null;
let lastStartedAt: number | null = saved.last_started_at ?? null;
let lastFinishedAt: number | null = saved.last_finished_at ?? null;
let lastSuccessAt: number | null = saved.last_success_at ?? null;
let lastDurationMs: number | null = saved.last_duration_ms ?? null;
let lastError: string | null = saved.running ? 'Previous maintenance interrupted; database recovery and queue replay resumed at startup' : saved.last_error ?? null;
let completedRuns = Number(saved.completed_runs || 0);
let errorRuns = Number(saved.error_runs || 0);
let skippedOverlappingRuns = 0;
let lastOperation: any = saved.last_operation ?? null;
let lastResults: any[] = saved.last_results ?? [];
onStoragePhase((value) => { if (running) phase = value; });
async function persist() {
  const handle = await fs.open(`${statePath}.tmp`, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(getRetentionSchedulerStatus())); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(`${statePath}.tmp`, statePath);
  const directory = await fs.open(path.dirname(statePath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function preferredDelay(delayMs: number) {
  let target = Date.now() + delayMs;
  if (maintenanceConfig.preferred_time_utc && lastSuccessAt !== null && lastStartedAt !== null) {
    const anchor = new Date(lastStartedAt);
    anchor.setUTCSeconds(0, 0);
    target = anchor.getTime() + maintenanceConfig.interval_ms;
  }
  if (maintenanceConfig.preferred_time_utc) {
    const [hours, minutes] = maintenanceConfig.preferred_time_utc.split(':').map(Number);
    const candidate = new Date(target);
    candidate.setUTCHours(hours, minutes, 0, 0);
    if (candidate.getTime() < target) candidate.setUTCDate(candidate.getUTCDate() + 1);
    while (candidate.getTime() <= Date.now()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    target = candidate.getTime();
  }
  return Math.max(1, target - Date.now());
}
function schedule(delayMs: number, align = true) {
  if (!maintenanceConfig.enabled) return;
  if (timer) clearTimeout(timer);
  const delay = align ? preferredDelay(delayMs) : Math.max(1000, delayMs);
  nextRunAt = Date.now() + delay;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (nextRunAt !== null && Date.now() < nextRunAt) arm();
      else void runRetentionOnce('scheduled');
    }, Math.min(2_000_000_000, Math.max(1, (nextRunAt ?? Date.now()) - Date.now())));
    timer.unref();
  };
  arm();
}
export async function runRetentionOnce(reason = 'manual') {
  if (running) { skippedOverlappingRuns++; return getRetentionSchedulerStatus(); }
  running = true; phase = 'preparing'; lastStartedAt = Date.now(); nextRunAt = null;
  if (timer) { clearTimeout(timer); timer = null; }
  let gateClosed = false;
  try {
    await persist();
    // Pause drain and finish its current commit before obtaining a fresh permission/drop snapshot.
    await storageCommand('pause');
    gateClosed = true;
    await closeDatabaseGate();
    captureMaintenanceSnapshot();
    lastOperation = await storageCommand('maintenance', { reason });
    lastResults = lastOperation.results;
    lastError = lastOperation.vacuum_skipped === 'insufficient_free_disk' ? 'Compaction skipped: insufficient free disk; pruning completed' : null;
    completedRuns++;
    if (lastOperation.complete && !lastError) lastSuccessAt = Date.now();
  } catch (error) {
    errorRuns++;
    if ((error as any).partial_result) { lastOperation = (error as any).partial_result; lastResults = lastOperation.results; }
    lastError = (error as Error).message || String(error);
    console.warn('Maintenance failed; database and queue retained:', lastError);
  } finally {
    // Native SQLite rolls back failed VACUUM. The worker has completed or exited before this resumes.
    if (gateClosed) { clearMaintenanceSnapshot(); openDatabaseGate(); }
    await storageCommand('resume');
    running = false; phase = lastError ? 'failed' : 'idle'; lastFinishedAt = Date.now();
    lastDurationMs = lastStartedAt === null ? null : lastFinishedAt - lastStartedAt;
    schedule(lastError || lastOperation?.complete === false ? Math.min(60_000, maintenanceConfig.interval_ms) : maintenanceConfig.interval_ms, !lastError && lastOperation?.complete !== false);
    try { await persist(); } catch (error) { lastError = `Could not persist maintenance status: ${(error as Error).message}`; phase = 'failed'; }
  }
  return getRetentionSchedulerStatus();
}
export function requestMaintenance(reason = 'manual') {
  if (!running) setImmediate(() => { void runRetentionOnce(reason); });
  return getRetentionSchedulerStatus();
}
export function startRetentionScheduler() {
  if (!maintenanceConfig.enabled || timer || running) return;
  if (lastError || lastOperation?.complete === false) {
    schedule(Math.min(60_000, maintenanceConfig.interval_ms), false);
    return;
  }
  const remaining = lastSuccessAt === null ? maintenanceConfig.initial_delay_ms : Math.max(maintenanceConfig.initial_delay_ms, lastSuccessAt + maintenanceConfig.interval_ms - Date.now());
  schedule(remaining);
}
export function stopRetentionScheduler() { if (timer) clearTimeout(timer); timer = null; nextRunAt = null; }
export function getRetentionSchedulerStatus() {
  return { enabled: maintenanceConfig.enabled, running, phase, interval_ms: maintenanceConfig.interval_ms,
    initial_delay_ms: maintenanceConfig.initial_delay_ms, next_run_at: nextRunAt,
    last_started_at: lastStartedAt, last_finished_at: lastFinishedAt, last_success_at: lastSuccessAt,
    last_duration_ms: lastDurationMs, completed_runs: completedRuns, skipped_overlapping_runs: skippedOverlappingRuns,
    busy_runs: 0, error_runs: errorRuns, last_error: lastError, last_results: lastResults,
    last_operation: lastOperation, prune_config: { batch_size: maintenanceConfig.prune_batch_size, max_runtime_ms: maintenanceConfig.prune_max_runtime_ms },
    configuration: maintenanceConfig, ingestion: getDurableIngestStatus() };
}
