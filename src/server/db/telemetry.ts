import { db, isTruthy, clampLimit, clampOffset } from './core.js';

// Prepared statements for inserts
const insertTraceStmt = db.prepare(`
  INSERT OR IGNORE INTO traces (drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      r.attributes
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
