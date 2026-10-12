function integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const preferredTime = process.env.RAPHAEL_MAINTENANCE_TIME_UTC || null;
if (preferredTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(preferredTime)) throw new Error('RAPHAEL_MAINTENANCE_TIME_UTC must be HH:mm');
const vacuumPolicy = process.env.RAPHAEL_MAINTENANCE_VACUUM_POLICY || 'full';
if (!['full', 'incremental', 'none'].includes(vacuumPolicy)) throw new Error('Invalid RAPHAEL_MAINTENANCE_VACUUM_POLICY');
export const maintenanceConfig = {
  enabled: !['0', 'false', 'off'].includes((process.env.RAPHAEL_RETENTION_ENABLED || 'true').toLowerCase()),
  interval_ms: integer('RAPHAEL_RETENTION_INTERVAL_MS', 2 * 86_400_000, 1_000, 365 * 86_400_000),
  initial_delay_ms: integer('RAPHAEL_RETENTION_INITIAL_DELAY_MS', 15_000, 0, 365 * 86_400_000),
  preferred_time_utc: preferredTime,
  vacuum_policy: vacuumPolicy as 'full' | 'incremental' | 'none',
  vacuum_min_reclaimable_bytes: integer('RAPHAEL_MAINTENANCE_VACUUM_MIN_BYTES', 64 * 1024 * 1024, 0),
  queue_max_items: integer('RAPHAEL_INGEST_QUEUE_MAX_ITEMS', 10_000, 1, 1_000_000),
  queue_max_bytes: integer('RAPHAEL_INGEST_QUEUE_MAX_BYTES', 1024 * 1024 * 1024, 1024),
  min_free_disk_bytes: integer('RAPHAEL_MIN_FREE_DISK_BYTES', 256 * 1024 * 1024, 0),
  queue_max_inflight_bytes: integer('RAPHAEL_INGEST_QUEUE_MAX_INFLIGHT_BYTES', 32 * 1024 * 1024, 1024),
  prune_batch_size: integer('RAPHAEL_PRUNE_BATCH_SIZE', 1000, 1, 50_000),
  prune_max_runtime_ms: integer('RAPHAEL_PRUNE_MAX_RUNTIME_MS', 30_000, 25, 3_600_000),
  incremental_vacuum_max_pages: integer('RAPHAEL_SQLITE_INCREMENTAL_VACUUM_MAX_PAGES', 2048, 1, 1_000_000),
  max_future_skew_ms: integer('RAPHAEL_INGEST_MAX_FUTURE_SKEW_MS', 300_000, 0),
};
export function telemetryTimestamp(raw: unknown, receivedAt: number): number {
  if (raw === undefined || raw === null || raw === '') return receivedAt;
  const time = typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw) ? Date.parse(raw) : Number(raw);
  if (!Number.isSafeInteger(time) || time < 0 || time > receivedAt + maintenanceConfig.max_future_skew_ms) {
    throw new Error('Invalid telemetry timestamp (expected Unix milliseconds or ISO date within future clock allowance)');
  }
  return time;
}
export function nanosTimestamp(raw: unknown, receivedAt: number): number {
  if (raw === undefined || raw === null || raw === '') return receivedAt;
  if (String(raw) === '0') return receivedAt;
  if (!/^\d+$/.test(String(raw))) throw new Error('Invalid OTLP telemetry timestamp');
  const time = Number(BigInt(String(raw)) / 1_000_000n);
  return telemetryTimestamp(time, receivedAt);
}
