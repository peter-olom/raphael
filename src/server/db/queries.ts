import { db, clampLimit, clampOffset, isTruthy } from './core.js';

export interface TraceQuery {
  q?: string;
  where?: Partial<{
    trace_id: string;
    service_name: string;
    operation_name: string;
    status: string;
  }>;
  range?: Partial<{
    start_time: { gte?: number; lte?: number };
    end_time: { gte?: number; lte?: number };
    duration_ms: { gte?: number; lte?: number };
    created_at: { gte?: number; lte?: number };
  }>;
  attributes?: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }>;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface WideEventQuery {
  q?: string;
  where?: Partial<{
    trace_id: string;
    service_name: string;
    operation_type: string;
    field_name: string;
    outcome: string;
    user_id: string;
  }>;
  range?: Partial<{
    duration_ms: { gte?: number; lte?: number };
    created_at: { gte?: number; lte?: number };
    error_count: { gte?: number; lte?: number };
    rpc_call_count: { gte?: number; lte?: number };
  }>;
  attributes?: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }>;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

function jsonPath(key: string) {
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `$."${escaped}"`;
}

function applyRange<T extends Record<string, { gte?: number; lte?: number }>>(
  field: string,
  range: T | undefined,
  where: string[],
  params: unknown[]
) {
  if (!range) return;
  const clause = range[field as keyof T] as { gte?: number; lte?: number } | undefined;
  if (!clause) return;
  if (clause.gte !== undefined) {
    where.push(`${field} >= ?`);
    params.push(clause.gte);
  }
  if (clause.lte !== undefined) {
    where.push(`${field} <= ?`);
    params.push(clause.lte);
  }
}

function applyAttributes(
  attrs: Array<{ key: string; op?: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: string | number | boolean }> | undefined,
  where: string[],
  params: unknown[]
) {
  if (!attrs || attrs.length === 0) return;
  for (const attr of attrs) {
    const key = attr.key?.toString().trim();
    if (!key) continue;
    const op = attr.op ?? 'eq';
    const path = jsonPath(key);
    if (op === 'exists') {
      where.push(`json_type(json_extract(attributes, ?)) IS NOT NULL`);
      params.push(path);
      continue;
    }
    const value = attr.value;
    if (value === undefined) continue;
    const expr = `json_extract(attributes, ?)`;
    if (op === 'like') {
      where.push(`CAST(${expr} AS TEXT) LIKE ?`);
      params.push(path, `%${value}%`);
    } else if (op === 'gt') {
      where.push(`${expr} > ?`);
      params.push(path, value);
    } else if (op === 'gte') {
      where.push(`${expr} >= ?`);
      params.push(path, value);
    } else if (op === 'lt') {
      where.push(`${expr} < ?`);
      params.push(path, value);
    } else if (op === 'lte') {
      where.push(`${expr} <= ?`);
      params.push(path, value);
    } else {
      where.push(`${expr} = ?`);
      params.push(path, value);
    }
  }
}

export function queryTraces(dropId: number, query: TraceQuery) {
  const where: string[] = ['drop_id = ?'];
  const params: unknown[] = [dropId];

  if (query.q) {
    const pattern = `%${query.q}%`;
    const includeAttributes = isTruthy(process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED);
    where.push(
      includeAttributes
        ? `(service_name LIKE ? OR operation_name LIKE ? OR trace_id LIKE ? OR attributes LIKE ?)`
        : `(service_name LIKE ? OR operation_name LIKE ? OR trace_id LIKE ?)`
    );
    params.push(...(includeAttributes ? [pattern, pattern, pattern, pattern] : [pattern, pattern, pattern]));
  }

  if (query.where?.trace_id) {
    where.push(`trace_id = ?`);
    params.push(query.where.trace_id);
  }
  if (query.where?.service_name) {
    where.push(`service_name = ?`);
    params.push(query.where.service_name);
  }
  if (query.where?.operation_name) {
    where.push(`operation_name = ?`);
    params.push(query.where.operation_name);
  }
  if (query.where?.status) {
    where.push(`status = ?`);
    params.push(query.where.status);
  }

  applyRange('start_time', query.range, where, params);
  applyRange('end_time', query.range, where, params);
  applyRange('duration_ms', query.range, where, params);
  applyRange('created_at', query.range, where, params);

  applyAttributes(query.attributes, where, params);

  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const sql = `
    SELECT id, drop_id, trace_id, span_id, parent_span_id, service_name, operation_name, start_time, end_time, duration_ms, status, created_at
    FROM traces
    WHERE ${where.join(' AND ')}
    ORDER BY id ${order}
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, limit, offset);
}

export function queryWideEvents(dropId: number, query: WideEventQuery) {
  const where: string[] = ['drop_id = ?'];
  const params: unknown[] = [dropId];

  if (query.q) {
    const pattern = `%${query.q}%`;
    const includeAttributes = isTruthy(process.env.RAPHAEL_SEARCH_ATTRIBUTES_ENABLED);
    where.push(
      includeAttributes
        ? `(service_name LIKE ? OR field_name LIKE ? OR trace_id LIKE ? OR user_id LIKE ? OR attributes LIKE ?)`
        : `(service_name LIKE ? OR field_name LIKE ? OR trace_id LIKE ? OR user_id LIKE ?)`
    );
    params.push(
      ...(includeAttributes
        ? [pattern, pattern, pattern, pattern, pattern]
        : [pattern, pattern, pattern, pattern])
    );
  }

  if (query.where?.trace_id) {
    where.push(`trace_id = ?`);
    params.push(query.where.trace_id);
  }
  if (query.where?.service_name) {
    where.push(`service_name = ?`);
    params.push(query.where.service_name);
  }
  if (query.where?.operation_type) {
    where.push(`operation_type = ?`);
    params.push(query.where.operation_type);
  }
  if (query.where?.field_name) {
    where.push(`field_name = ?`);
    params.push(query.where.field_name);
  }
  if (query.where?.outcome) {
    where.push(`outcome = ?`);
    params.push(query.where.outcome);
  }
  if (query.where?.user_id) {
    where.push(`user_id = ?`);
    params.push(query.where.user_id);
  }

  applyRange('duration_ms', query.range, where, params);
  applyRange('created_at', query.range, where, params);
  applyRange('error_count', query.range, where, params);
  applyRange('rpc_call_count', query.range, where, params);

  applyAttributes(query.attributes, where, params);

  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = clampLimit(query.limit);
  const offset = clampOffset(query.offset);
  const sql = `
    SELECT id, drop_id, trace_id, service_name, operation_type, field_name, outcome, duration_ms, user_id, error_count, rpc_call_count, created_at
    FROM wide_events
    WHERE ${where.join(' AND ')}
    ORDER BY id ${order}
    LIMIT ? OFFSET ?
  `;
  return db.prepare(sql).all(...params, limit, offset);
}
