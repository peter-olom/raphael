import { db, isTruthy, clampLimit, clampOffset, parsePositiveInt } from './core.js';
import { getAppSetting, setAppSetting } from './settings.js';

function clampInt(raw: unknown, fallback: number, min: number, max: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Prepared statements for inserts
const insertTraceStmt = db.prepare(`
  INSERT OR IGNORE INTO traces (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1
    FROM traces
    WHERE drop_id = ?
      AND trace_id = ?
      AND span_id IS ?
    LIMIT 1
  )
`);

const insertWideEventStmt = db.prepare(`
  INSERT INTO wide_events (drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export type TraceInsertRow = {
  drop_id: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  operation_name: string;
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  status: string;
  attributes: string;
};

export type WideEventInsertRow = {
  drop_id: number;
  trace_id: string | null;
  service_name: string;
  operation_type: string | null;
  field_name: string | null;
  outcome: string;
  duration_ms: number | null;
  user_id: string | null;
  error_count: number;
  rpc_call_count: number;
  attributes: string;
};

const insertTracesTx = db.transaction((rows: TraceInsertRow[]) => {
  for (const r of rows) {
    insertTraceStmt.run(
      r.drop_id,
      r.trace_id,
      r.span_id,
      r.parent_span_id,
      r.service_name,
      r.operation_name,
      r.start_time,
      r.end_time,
      r.duration_ms,
      r.status,
      r.attributes,
      r.drop_id,
      r.trace_id,
      r.span_id
    );
  }
});

const insertWideEventsTx = db.transaction((rows: WideEventInsertRow[]) => {
  for (const r of rows) {
    insertWideEventStmt.run(
      r.drop_id,
      r.trace_id,
      r.service_name,
      r.operation_type,
      r.field_name,
      r.outcome,
      r.duration_ms,
      r.user_id,
      r.error_count,
      r.rpc_call_count,
      r.attributes
    );
  }
});

export function insertTraceRows(rows: TraceInsertRow[]) {
  if (rows.length === 0) return;
  insertTracesTx(rows);
}

export function insertWideEventRows(rows: WideEventInsertRow[]) {
  if (rows.length === 0) return;
  insertWideEventsTx(rows);
}

export function insertTraceRow(
  dropId: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  serviceName: string,
  operationName: string,
  startTime: number,
  endTime: number | null,
  durationMs: number | null,
  status: string,
  attributes: string
) {
  insertTraceRows([
    {
      drop_id: dropId,
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      service_name: serviceName,
      operation_name: operationName,
      start_time: startTime,
      end_time: endTime,
      duration_ms: durationMs,
      status,
      attributes,
    },
  ]);
}

export function insertWideEventRow(
  dropId: number,
  traceId: string | null,
  serviceName: string,
  operationType: string | null,
  fieldName: string | null,
  outcome: string,
  durationMs: number | null,
  userId: string | null,
  errorCount: number,
  rpcCallCount: number,
  attributes: string
) {
  insertWideEventRows([
    {
      drop_id: dropId,
      trace_id: traceId,
      service_name: serviceName,
      operation_type: operationType,
      field_name: fieldName,
      outcome,
      duration_ms: durationMs,
      user_id: userId,
      error_count: errorCount,
      rpc_call_count: rpcCallCount,
      attributes,
    },
  ]);
}

// Query helpers
export function getRecentTraces(dropId: number, limit = 100, offset = 0, beforeId?: number | null, maxLimit = 2000) {
  const lim = clampLimit(limit, maxLimit);
  const off = beforeId ? 0 : clampOffset(offset);
  if (beforeId && Number.isFinite(beforeId) && beforeId > 0) {
    return db.prepare(`
      SELECT id, drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, created_at
      FROM traces
      WHERE drop_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(dropId, Math.floor(beforeId), lim);
  }
  return db.prepare(`
    SELECT id, drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, created_at
    FROM traces
    WHERE drop_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(dropId, lim, off);
}

export function getRecentWideEvents(dropId: number, limit = 100, offset = 0, beforeId?: number | null, maxLimit = 2000) {
  const lim = clampLimit(limit, maxLimit);
  const off = beforeId ? 0 : clampOffset(offset);
  if (beforeId && Number.isFinite(beforeId) && beforeId > 0) {
    return db.prepare(`
      SELECT id, drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, created_at
      FROM wide_events
      WHERE drop_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(dropId, Math.floor(beforeId), lim);
  }
  return db.prepare(`
    SELECT id, drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, created_at
    FROM wide_events
    WHERE drop_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(dropId, lim, off);
}

export function getTraceById(dropId: number, traceId: string) {
  return db.prepare(`
    SELECT * FROM traces
    WHERE drop_id = ?
      AND trace_id = ?
    ORDER BY start_time ASC
  `).all(dropId, traceId);
}

export function getWideEventsByTraceId(dropId: number, traceId: string) {
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE drop_id = ?
      AND trace_id = ?
    ORDER BY id ASC
  `).all(dropId, traceId);
}

export function getWideEventById(dropId: number, eventId: number) {
  return db.prepare(`
    SELECT * FROM wide_events
    WHERE drop_id = ?
      AND id = ?
  `).get(dropId, eventId);
}

export function searchTraces(dropId: number, query: string, limit = 100) {
  const clean = query.trim();
  if (!clean) return [];
  const pattern = `%${clean}%`;
  const lim = clampLimit(limit);
  const includeAttributes = isTruthy(process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED);
  return db.prepare(`
    SELECT id, drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, created_at
    FROM traces
    WHERE drop_id = ?
      AND (
        service_name LIKE ?
        OR operation_name LIKE ?
        OR trace_id LIKE ?
        ${includeAttributes ? 'OR attributes LIKE ?' : ''}
      )
    ORDER BY id DESC
    LIMIT ?
  `).all(...(includeAttributes ? [dropId, pattern, pattern, pattern, pattern, lim] : [dropId, pattern, pattern, pattern, lim]));
}

export function searchWideEvents(dropId: number, query: string, limit = 100) {
  const clean = query.trim();
  if (!clean) return [];
  const pattern = `%${clean}%`;
  const lim = clampLimit(limit);
  const includeAttributes = isTruthy(process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED);
  return db.prepare(`
    SELECT id, drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, created_at
    FROM wide_events
    WHERE drop_id = ?
      AND (
        service_name LIKE ?
        OR field_name LIKE ?
        OR trace_id LIKE ?
        OR user_id LIKE ?
        ${includeAttributes ? 'OR attributes LIKE ?' : ''}
      )
    ORDER BY id DESC
    LIMIT ?
  `).all(...(includeAttributes ? [dropId, pattern, pattern, pattern, pattern, pattern, lim] : [dropId, pattern, pattern, pattern, pattern, lim]));
}

export function getStats(dropId: number) {
  const traceCount = db
    .prepare('SELECT COUNT(*) as count FROM traces WHERE drop_id = ?')
    .get(dropId) as { count: number };
  const eventCount = db
    .prepare('SELECT COUNT(*) as count FROM wide_events WHERE drop_id = ?')
    .get(dropId) as { count: number };
  const errorCount = db
    .prepare('SELECT COUNT(*) as count FROM wide_events WHERE drop_id = ? AND outcome = ?')
    .get(dropId, 'error') as { count: number };

  return {
    traces: traceCount.count,
    wideEvents: eventCount.count,
    errors: errorCount.count,
  };
}

export function clearAll(dropId?: number) {
  if (dropId === undefined) {
    db.exec('DELETE FROM traces; DELETE FROM wide_events;');
    return;
  }
  db.prepare('DELETE FROM traces WHERE drop_id = ?').run(dropId);
  db.prepare('DELETE FROM wide_events WHERE drop_id = ?').run(dropId);
}

const TRACE_SPAN_DEDUP_CURSOR_SETTING = 'raphael.trace_span_dedup.cursor';

function parseSettingInt(value: string | undefined, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function isSqliteBusy(error: unknown) {
  const code = (error as any)?.code?.toString?.() ?? '';
  const message = (error as Error)?.message ?? '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(message);
}

export interface TraceSpanDedupStatus {
  cursor_id: number;
  max_trace_id: number;
  complete: boolean;
}

export interface TraceSpanDedupResult extends TraceSpanDedupStatus {
  cursor_start_id: number;
  cursor_end_id: number;
  windows_scanned: number;
  traces_deleted: number;
  runtime_ms: number;
  timed_out: boolean;
  busy: boolean;
}

const deleteDuplicateTraceSpansWindow = db.prepare(`
  DELETE FROM traces
  WHERE id > ?
    AND id <= ?
    AND span_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM traces keep
      WHERE keep.drop_id = traces.drop_id
        AND keep.trace_id = traces.trace_id
        AND keep.span_id IS traces.span_id
        AND keep.id < traces.id
      LIMIT 1
    )
`);

function getMaxTraceId() {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM traces`).get() as { max_id: number };
  return Number(row?.max_id ?? 0);
}

export function getTraceSpanDedupStatus(): TraceSpanDedupStatus {
  const cursorId = parseSettingInt(getAppSetting(TRACE_SPAN_DEDUP_CURSOR_SETTING), 0);
  const maxTraceId = getMaxTraceId();
  return {
    cursor_id: cursorId,
    max_trace_id: maxTraceId,
    complete: cursorId >= maxTraceId,
  };
}

export function dedupeTraceSpans(options: { id_window_size?: unknown; max_runtime_ms?: unknown; start_after_id?: unknown } = {}) {
  const windowSize = clampInt(
    options.id_window_size ?? process.env.RAPHAEL_TRACE_DEDUP_ID_WINDOW_SIZE,
    parsePositiveInt(process.env.RAPHAEL_TRACE_DEDUP_ID_WINDOW_SIZE, 10_000),
    100,
    100_000
  );
  const maxRuntimeMs = clampInt(
    options.max_runtime_ms ?? process.env.RAPHAEL_TRACE_DEDUP_MAX_RUNTIME_MS,
    parsePositiveInt(process.env.RAPHAEL_TRACE_DEDUP_MAX_RUNTIME_MS, 500),
    25,
    30_000
  );
  const maxTraceId = getMaxTraceId();
  const requestedStartAfterId = Number(options.start_after_id);
  const cursorStartId = Math.max(
    0,
    Math.floor(
      Number.isFinite(requestedStartAfterId)
        ? requestedStartAfterId
        : parseSettingInt(getAppSetting(TRACE_SPAN_DEDUP_CURSOR_SETTING), 0)
    )
  );
  const startedAt = Date.now();
  const deadline = startedAt + maxRuntimeMs;
  let cursorId = Math.min(cursorStartId, maxTraceId);
  let tracesDeleted = 0;
  let windowsScanned = 0;
  let busy = false;

  while (cursorId < maxTraceId && Date.now() < deadline) {
    const windowEndId = Math.min(cursorId + windowSize, maxTraceId);
    try {
      const changes = deleteDuplicateTraceSpansWindow.run(cursorId, windowEndId).changes;
      tracesDeleted += changes;
      windowsScanned++;
      cursorId = windowEndId;
      setAppSetting(TRACE_SPAN_DEDUP_CURSOR_SETTING, String(cursorId));
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      busy = true;
      break;
    }
  }

  return {
    cursor_id: cursorId,
    cursor_start_id: cursorStartId,
    cursor_end_id: cursorId,
    max_trace_id: maxTraceId,
    complete: cursorId >= maxTraceId,
    windows_scanned: windowsScanned,
    traces_deleted: tracesDeleted,
    runtime_ms: Date.now() - startedAt,
    timed_out: Date.now() >= deadline && cursorId < maxTraceId,
    busy,
  } satisfies TraceSpanDedupResult;
}
