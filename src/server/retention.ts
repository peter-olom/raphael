import { pruneByRetention, getRetentionPruneConfig, type RetentionPruneResult } from './db/sqlite.js';

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function clampInt(raw: unknown, fallback: number, min: number, max: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export interface RetentionSchedulerStatus {
  enabled: boolean;
  running: boolean;
  interval_ms: number;
  initial_delay_ms: number;
  next_run_at: number | null;
  last_started_at: number | null;
  last_finished_at: number | null;
  last_duration_ms: number | null;
  completed_runs: number;
  skipped_overlapping_runs: number;
  busy_runs: number;
  error_runs: number;
  last_error: string | null;
  last_results: RetentionPruneResult[];
  prune_config: ReturnType<typeof getRetentionPruneConfig>;
}

const enabled = boolEnv('RAPHAEL_RETENTION_ENABLED', true);
const intervalMs = clampInt(process.env.RAPHAEL_RETENTION_INTERVAL_MS, 60_000, 10_000, 3_600_000);
const initialDelayMs = clampInt(process.env.RAPHAEL_RETENTION_INITIAL_DELAY_MS, 15_000, 1_000, 300_000);

let timer: NodeJS.Timeout | null = null;
let running = false;
let nextRunAt: number | null = null;
let lastStartedAt: number | null = null;
let lastFinishedAt: number | null = null;
let lastDurationMs: number | null = null;
let completedRuns = 0;
let skippedOverlappingRuns = 0;
let busyRuns = 0;
let errorRuns = 0;
let lastError: string | null = null;
let lastResults: RetentionPruneResult[] = [];
let lastPrunedDropId: number | null = null;

function summarize(results: RetentionPruneResult[]) {
  return results.reduce(
    (acc, r) => {
      acc.traces += r.traces_deleted;
      acc.events += r.events_deleted;
      acc.batches += r.batches;
      acc.busy ||= r.busy;
      acc.timedOut ||= r.timed_out;
      return acc;
    },
    { traces: 0, events: 0, batches: 0, busy: false, timedOut: false }
  );
}

function schedule(delayMs: number) {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  const delay = Math.max(1_000, delayMs);
  nextRunAt = Date.now() + delay;
  timer = setTimeout(() => {
    timer = null;
    void runRetentionOnce('scheduled');
  }, delay);
  timer.unref?.();
}

export async function runRetentionOnce(reason = 'manual') {
  if (!enabled) return getRetentionSchedulerStatus();
  if (running) {
    skippedOverlappingRuns++;
    return getRetentionSchedulerStatus();
  }

  running = true;
  lastStartedAt = Date.now();
  nextRunAt = null;
  try {
    const results = pruneByRetention(undefined, Date.now(), {
      startAfterDropId: lastPrunedDropId,
    });
    lastResults = results;
    if (results.length > 0) {
      lastPrunedDropId = results[results.length - 1].drop_id;
    }
    const summary = summarize(results);
    if (summary.busy) busyRuns++;
    lastError = null;
    completedRuns++;
    if (summary.traces > 0 || summary.events > 0 || summary.busy || summary.timedOut) {
      console.log(
        `Retention prune (${reason}): traces=${summary.traces} events=${summary.events} batches=${summary.batches} busy=${summary.busy} timedOut=${summary.timedOut}`
      );
    }
  } catch (error) {
    errorRuns++;
    lastError = (error as Error).message || String(error);
    console.warn('Retention prune failed; will retry on next interval:', error);
  } finally {
    lastFinishedAt = Date.now();
    lastDurationMs = lastStartedAt ? lastFinishedAt - lastStartedAt : null;
    running = false;
    schedule(intervalMs);
  }

  return getRetentionSchedulerStatus();
}

export function startRetentionScheduler() {
  if (!enabled) {
    console.log('Retention scheduler disabled via RAPHAEL_RETENTION_ENABLED=0');
    return;
  }
  if (timer || running) return;
  console.log(
    `Retention scheduler enabled: interval=${intervalMs}ms initialDelay=${initialDelayMs}ms batch=${getRetentionPruneConfig().batch_size} maxRuntime=${getRetentionPruneConfig().max_runtime_ms}ms`
  );
  schedule(initialDelayMs);
}

export function stopRetentionScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
}

export function getRetentionSchedulerStatus(): RetentionSchedulerStatus {
  return {
    enabled,
    running,
    interval_ms: intervalMs,
    initial_delay_ms: initialDelayMs,
    next_run_at: nextRunAt,
    last_started_at: lastStartedAt,
    last_finished_at: lastFinishedAt,
    last_duration_ms: lastDurationMs,
    completed_runs: completedRuns,
    skipped_overlapping_runs: skippedOverlappingRuns,
    busy_runs: busyRuns,
    error_runs: errorRuns,
    last_error: lastError,
    last_results: lastResults,
    prune_config: getRetentionPruneConfig(),
  };
}
