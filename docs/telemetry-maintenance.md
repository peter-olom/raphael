# Durable ingestion and telemetry maintenance

Raphael now acknowledges traces, direct events, and OTLP logs after persisting them to a bounded disk queue. A storage worker drains that queue and runs retention and compaction. HTTP health checks remain available while maintenance runs; existing-drop ingestion continues through the queue.

This change is local and has not been deployed. The existing database, volumes, remote services, and remote configuration have not been changed.

## Storage and retention contract

Each nonempty ingestion request gets its own queue identity. Before HTTP 200, Raphael writes the request, syncs the file, renames it into the queue, and syncs the directory. An acknowledged request can be queued briefly before queries can see it. The worker commits telemetry and its replay receipt in one transaction with SQLite `synchronous=FULL`. It removes the queue file only after that commit, syncs the removal, and then cleans up the receipt. Startup replays committed receipts without inserting their events again.

This guarantees duplicate-safe **queue replay** under the verified process-crash scenarios. It does not promise exactly-once delivery across client retries. Events and logs submitted again in another HTTP request remain separate records, including identical payloads. Spans retain the existing identity of drop + trace ID + span ID.

Retention is independent for each drop and each telemetry type. Existing per-drop settings remain authoritative; new drops default to three days for traces and seven days for events. Zero days disables retention for that type. Both pruning and queue replay discard records only when their retention timestamp is strictly older than the cutoff. Replay counts expired traces, expired events, and records for drops which have since been deleted.

The retention timestamp is separate from `created_at`, which remains the original HTTP arrival time:

| Input | Retention timestamp |
| --- | --- |
| OTLP trace | Required `startTimeUnixNano`, converted to milliseconds. Missing/zero, invalid, or excessively future values are rejected through OTLP partial success. |
| OTLP log | Nonzero `timeUnixNano`, otherwise nonzero `observedTimeUnixNano`, otherwise HTTP arrival time. Invalid or excessively future values are rejected through OTLP partial success. |
| Direct event | `timestamp`, as Unix milliseconds or an ISO date. Missing/null/empty values use HTTP arrival time. Invalid or excessively future values return HTTP 400 for the request. |
| Previously stored record | Existing `created_at`. The migration leaves the new source-time column empty and preserves the previous retention semantics. |

Future timestamps have a configurable five-minute allowance. Queuing, restarts, and replay never refresh the source timestamp or the original arrival time. Explicit missing numeric drop IDs return 404; they do not fall back to the default drop. Numeric IDs, including leading zeros, resolve the same way during maintenance.

OTLP support remains HTTP JSON. All OTLP log records now become events, including ordinary logs previously ignored by the wide-event-only receiver. Event attributes preserve the original OTLP body, severity, resource, scope, raw nested attributes, span ID, and flags under `otel.*` keys. Existing wide-event fields still populate their usual columns. This can increase storage volume for exporters which send ordinary logs.

## Coordination and maintenance

A native SQLite sidecar lease prevents a second Raphael process from opening the same database. The lease uses a canonical database path and a held exclusive transaction; process death releases the OS lock. The stable sidecar file is never replaced or unlinked. This also prevents a second process using a database symlink alias from bypassing ownership.

During normal operation, worker commits obtain an exclusive grant after existing HTTP/auth/WebSocket database operations finish. New database requests wait asynchronously for at most one second, with at most 100 waiting requests; excess or timed-out requests get HTTP 503 and `Retry-After: 2`. Health checks do not enter that gate.

A maintenance cycle pauses the drain after its current write finishes, waits for in-flight database work, and captures current drop/auth permissions. It prunes in bounded batches on the worker, checkpoints SQLite, and compacts only when reclaimable space exceeds the configured threshold. Native in-place VACUUM keeps SQLite's recovery behavior; it does not swap or replace the application database. The worker checks free space before full VACUUM and reserves twice the database size plus minimum free space and the configured queue allowance.

During maintenance:

- `/health` stays available without querying SQLite or resolving credentials.
- Existing-drop ingestion accepts API keys from the fresh permission snapshot. Previously verified session cookies work only if their session ID, token, expiry, user status, and current permissions still match the snapshot.
- Uncached or revoked session cookies retry with 503. Invalid API keys remain unauthorized. New drop creation retries with 503.
- Queries, sign-in/session endpoints, admin/account mutations, and new WebSocket connections retry. Existing WebSocket subscriptions receive a retryable error when trying to change drops.
- Existing streams publish bounded notifications only after records commit. Queued or expired records are not announced as stored.

`POST /api/maintenance/compact` remains admin-only and now returns HTTP 202 with status. It starts the coordinated prune/threshold-based compaction cycle. Repeated triggers do not create overlapping cycles. Disabling the scheduler still permits a manual cycle.

The default two-day interval is the nominal extra retention allowance between successful cycles. Pruning runtime, preferred-time alignment, failures, disk shortages, or downtime can extend it; it is not a hard two-day age limit. An incomplete prune, failed cycle, or compaction skipped for insufficient disk retries within at most one minute. Compaction below the threshold, disabled by policy, or unavailable for a legacy incremental layout waits for the normal next cycle. The drain resumes during ongoing arrivals rather than waiting for ingestion to stop.

## Configuration

Invalid numeric or enum settings fail startup instead of silently changing their meaning. Configuration is read at startup; change it through the normal release/configuration process and restart. Per-drop retention continues to use the existing admin API.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAPHAEL_RETENTION_ENABLED` | `true` | Enable scheduled cycles; manual cycles remain available. |
| `RAPHAEL_RETENTION_INTERVAL_MS` | `172800000` | Two days. Supported range: 1 second to 365 days. Long schedules use bounded timers. |
| `RAPHAEL_RETENTION_INITIAL_DELAY_MS` | `15000` | Initial scheduling delay; saved successful cycle state is considered on restart. |
| `RAPHAEL_MAINTENANCE_TIME_UTC` | unset | Optional daily `HH:mm` window; alignment can extend the nominal interval. |
| `RAPHAEL_MAINTENANCE_VACUUM_POLICY` | `full` | `full`, `incremental`, or `none`. Every cycle still prunes. |
| `RAPHAEL_MAINTENANCE_VACUUM_MIN_BYTES` | `67108864` | Compact only when reclaimable bytes are **greater than** 64 MiB. |
| `RAPHAEL_PRUNE_BATCH_SIZE` | `1000` | Maximum rows per delete batch, up to 50,000. |
| `RAPHAEL_PRUNE_MAX_RUNTIME_MS` | `30000` | Prune budget per cycle. Incomplete cycles retry soon and skip VACUUM. |
| `RAPHAEL_SQLITE_INCREMENTAL_VACUUM_MAX_PAGES` | `2048` | Page budget for incremental policy. Legacy databases without incremental auto-vacuum skip that operation explicitly. |
| `SQLITE_TMPDIR` | canonical database path + `.tmp` | Writable disk-backed SQLite temporary directory, set in the main process before any database opens. Full VACUUM checks its free space as well as database disk space. |
| `RAPHAEL_INGEST_QUEUE_DIR` | canonical database path + `.ingest` | Persistent directory dedicated to this database. A synced manifest rejects accidental cross-database reuse. |
| `RAPHAEL_INGEST_QUEUE_MAX_BYTES` | `1073741824` | 1 GiB on disk, including reservations for concurrent writes. |
| `RAPHAEL_INGEST_QUEUE_MAX_ITEMS` | `10000` | Maximum pending request files; bounds metadata work for small requests. |
| `RAPHAEL_INGEST_QUEUE_MAX_INFLIGHT_BYTES` | `33554432` | 32 MiB of concurrent serialization/persistence allowance. Before parsing, each ingestion request reserves its full 10 MiB body budget; at least one body slot is permitted. |
| `RAPHAEL_MIN_FREE_DISK_BYTES` | `268435456` | 256 MiB minimum free disk, checked on queue and database filesystems. The worker also guards database commit space. |
| `RAPHAEL_INGEST_MAX_FUTURE_SKEW_MS` | `300000` | Five-minute future source-time allowance. |

The 10 MiB HTTP body and 5,000-item limits remain. Normalized telemetry is also capped at 10 MiB per request, preventing repeated OTLP resource/scope data from multiplying memory use; oversized normalized batches return 413 and must be split. Queue bytes/items, parser/persistence capacity, or disk exhaustion return retryable HTTP 503 before acknowledging telemetry. Rate limiting retains HTTP 429. The queue holds payloads on disk; the worker keeps one request plus at most 100 selected file names in memory.

## Status and recovery

`GET /api/admin/retention` exposes configuration, phase, last start/finish/success, next run, errors, per-drop deletions, partial failure progress, reclaimed bytes, checkpoint/prune/VACUUM/optimization durations, queue depth/bytes, pending persistence, oldest arrival/age, worker state, and persisted storage counters. It also exposes actual last ingest-to-commit delay and last/maximum commit duration; oldest queue age is a separate measurement. `/health` exposes lightweight maintenance and ingestion readiness.

Maintenance status is synced alongside the database. A failed cycle records its failure and reopens the request gate. Native SQLite retains the original database on a failed VACUUM; queued ingestion remains available for replay. A worker-only failure temporarily rejects new ingestion while pending persistence finishes and queue metadata is rescanned, then restarts the worker. The HTTP health endpoint stays available.

An unlink followed by a directory-sync error preserves the receipt. The next drain retries directory synchronization and receipt cleanup, even when the queue file is already absent. A corrupt/unsupported queue file is retained and stops replay with a visible error; operator repair is required. Do not delete acknowledged queue files to clear an error.

## Rollout prerequisites

- Back up the database together with pending queue data and maintenance state. Restore them as one unit. Keep the queue manifest bound to the intended canonical database path; moving a restore requires an explicit manifest/path migration.
- Persist the queue and sibling state/owner files on writable storage with the application database. Existing Docker volume ownership must permit their creation. SQLite temporary files default to a dedicated directory on the database volume, avoiding Compose’s 64 MiB `/tmp` tmpfs. If overriding `SQLITE_TMPDIR`, provide writable disk storage with enough compaction capacity. The local Docker and Compose health probes now use `/health`; no container or remote service was changed.
- Stop the existing application process before first startup of this version; older versions do not participate in the new ownership lease. Plan first startup as a migration window. Adding source-time expression indexes scans existing telemetry and can use substantial disk and time on a large database. Verify backup, available space, and migration duration before starting a production rollout.
- Use a local filesystem with working SQLite locks, atomic same-filesystem rename, file sync, and directory sync. The durability design depends on the filesystem/device honoring those operations. NFS/shared multi-host storage and external writers which bypass Raphael's coordination are unsupported.
- Exporter/collector persistent queues, retry configuration, and deployment settings are separate later work. Prepare them to cover first-migration downtime and retryable backpressure; this change does not configure collectors.
- Existing environment values override the new defaults. The reported live `RAPHAEL_RETENTION_INTERVAL_MS=10000` must be explicitly changed to `172800000` during a later authorized rollout; this local change does not update it.
- Budget queue capacity for measured incoming bytes during the longest expected maintenance operation, and budget full VACUUM disk headroom separately. Validate production resource limits and a representative large database before rollout. No 33 GiB/512 MiB production-scale benchmark or physical power-loss experiment was performed.

## Local verification

Verification used disposable isolated databases and compiled HTTP servers. No persistent automated tests or package/CI test commands were added. The following flows were exercised:

- Ingestion/query before maintenance, ingestion/health during maintenance, and replay/query/streaming afterward while new arrivals continued.
- Independent trace/event retention across two drops: one drop deleted one trace and 3,000 events; another deleted one trace and retained its events/log. Full compaction reclaimed 12,902,400 bytes.
- A bounded 3,500 ms worker hold made the maintenance window observable. During it, 20 health responses took at most 2.10 ms and 20 durable ingestion responses at most 15.0 ms in that run. These timings prove responsiveness in this local fixture; they are not a production VACUUM benchmark.
- Exact SIGKILL handoffs: persisted queue before commit; committed telemetry plus receipt while the queue remained; and removed queue with receipt remaining. Each restart retained exactly three events, including two intentionally identical deliveries, removed orphan receipts, and passed SQLite integrity check.
- Queue-byte and minimum-disk admission rejection, persisted maintenance failure and reopening, exclusive owner rejection, and cross-database queue manifest rejection.

Focused final checks also passed:

- Both expired traces and expired events were discarded on restart replay. At a fixed source-time cutoff, the record one millisecond older was deleted and records at equality and one millisecond newer remained, for both types.
- An injected directory-sync failure after unlink healed without restarting HTTP. A worker-only exit after unlink restarted, rescanned counters, cleared its receipt, and accepted/drained subsequent data. Both checks ended with two events and zero queued bytes.
- Canonical owner rejection, symlink-alias rejection, and SIGKILL lease recovery passed. A numeric drop named `1` did not override numeric ID `01` during maintenance; explicit missing IDs returned 404 without inserting into the default drop.
- Real BetterAuth session and API-key flows exercised live cached-session ingestion (200), API-key ingestion (200), revoked cached-session retry (503), invalid-key rejection (401), account/auth mutation gates (503), existing WebSocket subscription retry, and new WebSocket close (1013). The fixture created one temporary user, two sessions, one service account, and one API key; all were removed with the fixture database. No credentials or identities were retained.
- Auth QA required adding the optional `account.issuer` column **only to the disposable fixture**. The unmodified repository schema currently lacks it and signup fails against installed BetterAuth with `SQLITE_ERROR`. This baseline signup incompatibility was not changed, and unmodified signup is not validated by this work.
- On the small auth fixture, the native VACUUM itself measured 2.46 ms, separately from the synthetic 3,500 ms hold. Health took 1.80 ms; persisted ingest-to-commit delay was 3,511 ms and commit duration 1 ms. These measurements describe the local fixture only.
- A native empty-name SQLite temporary attachment, matching VACUUM's temporary-file mechanism, was observed by `lsof` inside the dedicated database-volume temporary directory. A simulated exhausted temporary filesystem skipped compaction with the recorded disk error and resumed ingestion. The default small container `/tmp` was not used for that attachment.
- A 710,662-byte OTLP trace request whose repeated 64 KiB service name would expand into hundreds of MiB returned 413 before acknowledgement. An amplified OTLP log request also returned 413. A subsequent valid trace committed and queried successfully. Invalid object-valued identifiers and non-finite numeric fields rejected before acknowledgement, followed by successful valid ingestion.
- Committed WebSocket batching respected the configured 128-row batch size: a 550-event request stored all 550 and streamed the capped 500 in frames of 128, 128, 128, and 116 rows.
- The compiled server and source `tsx` entry both accepted ingestion and served `/api/stats`. `npm run build` passed for server and client; whitespace/diff checks passed. Existing unrelated client/filter work was preserved.

All disposable servers, scripts, databases, queues, temporary attachments, and fixture identities were removed. No persistent tests, branch, commit, push, deploy, remote service operation, or live configuration/database change was performed.
