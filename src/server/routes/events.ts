import { Router, Request, Response } from 'express';
import { insertWideEventRows, resolveDropId, type WideEventInsertRow } from '../db/sqlite.js';
import { broadcast, hasSubscribers } from '../websocket.js';
import { authEnabled, noteApiKeyUsageDrop, requireAuth, requireDropAccess } from '../auth.js';

export const eventsRouter = Router();

function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function makeRingBuffer<T>(max: number) {
  const buf: T[] = [];
  let start = 0;
  return {
    push(item: T) {
      if (max <= 0) return;
      if (buf.length < max) buf.push(item);
      else {
        buf[start] = item;
        start = (start + 1) % max;
      }
    },
    toArray() {
      if (buf.length === 0) return [];
      if (buf.length < max) return buf.slice();
      return buf.slice(start).concat(buf.slice(0, start));
    },
    size() {
      return buf.length;
    },
  };
}

interface WideEvent {
  trace_id?: string;
  'service.name'?: string;
  'graphql.operation_type'?: string;
  'graphql.field_name'?: string;
  outcome?: string;
  'duration.total_ms'?: number;
  'user.id'?: string;
  error_count?: number;
  'count.rpc_calls'?: number;
  [key: string]: unknown;
}

// Wide events receiver - accepts array of events
eventsRouter.post('/v1/events', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const rawDrop = (req.header('x-raphael-drop') || (req.query.drop as string) || '').toString();
    const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
    const dropId = resolveDropId(rawDrop, allowCreate);
    if (dropId === null) {
      res.status(404).json({ error: 'Drop not found' });
      return;
    }
    noteApiKeyUsageDrop(req, dropId);
    if (!requireDropAccess(req, res, dropId, 'ingest')) return;
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const rows: WideEventInsertRow[] = [];

    const shouldBroadcast = hasSubscribers(dropId);
    const maxBroadcast = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_MAX_ITEMS, 500);
    const batchSize = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_BATCH_SIZE, 200);
    const broadcastBuf = shouldBroadcast ? makeRingBuffer<any>(maxBroadcast) : null;
    const createdAt = Date.now();

    for (const event of events as WideEvent[]) {
      const traceId = event.trace_id || null;
      const serviceName = (event['service.name'] ?? 'unknown') as any;
      const operationType = (event['graphql.operation_type'] ?? null) as any;
      const fieldName = (event['graphql.field_name'] ?? null) as any;
      const outcome = (event.outcome ?? 'unknown') as any;
      const durationMs = (event['duration.total_ms'] ?? null) as any;
      const userId = (event['user.id'] ?? null) as any;
      const errorCount = Number(event.error_count ?? 0) || 0;
      const rpcCallCount = Number(event['count.rpc_calls'] ?? 0) || 0;
      const attributes = JSON.stringify(event ?? {}) ?? '{}';
      const durationNum = durationMs === null ? null : Number(durationMs);
      const durationValue = durationNum !== null && Number.isFinite(durationNum) ? durationNum : null;

      rows.push({
        drop_id: dropId,
        trace_id: traceId,
        service_name: String(serviceName ?? 'unknown'),
        operation_type: operationType === null ? null : String(operationType),
        field_name: fieldName === null ? null : String(fieldName),
        outcome: String(outcome ?? 'unknown'),
        duration_ms: durationValue,
        user_id: userId === null ? null : String(userId),
        error_count: errorCount,
        rpc_call_count: rpcCallCount,
        attributes,
      });

      if (broadcastBuf) {
        broadcastBuf.push({
          drop_id: dropId,
          trace_id: traceId,
          service_name: String(serviceName ?? 'unknown'),
          operation_type: operationType === null ? null : String(operationType),
          field_name: fieldName === null ? null : String(fieldName),
          outcome: String(outcome ?? 'unknown'),
          duration_ms: durationValue,
          user_id: userId === null ? null : String(userId),
          error_count: errorCount,
          rpc_call_count: rpcCallCount,
          attributes,
          created_at: createdAt,
        });
      }
    }

    if (rows.length > 0) {
      insertWideEventRows(rows);
    }

    // Broadcast to connected clients (capped + batched).
    if (broadcastBuf && broadcastBuf.size() > 0) {
      const data = broadcastBuf.toArray();
      for (let i = 0; i < data.length; i += batchSize) {
        broadcast({ type: 'wide_events', drop_id: dropId, data: data.slice(i, i + batchSize) }, dropId);
      }
    }

    res.status(200).json({ received: events.length });
  } catch (error) {
    console.error('Error processing wide events:', error);
    res.status(500).json({ error: 'Failed to process events' });
  }
});

// Also support OTLP logs format (for compatibility with existing WideEventEmitter)
eventsRouter.post('/v1/logs', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const rawDrop = (req.header('x-raphael-drop') || (req.query.drop as string) || '').toString();
    const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
    const dropId = resolveDropId(rawDrop, allowCreate);
    if (dropId === null) {
      res.status(404).json({ error: 'Drop not found' });
      return;
    }
    noteApiKeyUsageDrop(req, dropId);
    if (!requireDropAccess(req, res, dropId, 'ingest')) return;
    const body = req.body;
    const rows: WideEventInsertRow[] = [];

    const shouldBroadcast = hasSubscribers(dropId);
    const maxBroadcast = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_MAX_ITEMS, 500);
    const batchSize = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_BATCH_SIZE, 200);
    const broadcastBuf = shouldBroadcast ? makeRingBuffer<any>(maxBroadcast) : null;
    const createdAt = Date.now();

    if (body.resourceLogs) {
      for (const resourceLog of body.resourceLogs) {
        const serviceName = extractServiceName(resourceLog.resource);

        for (const scopeLog of resourceLog.scopeLogs || []) {
          for (const logRecord of scopeLog.logRecords || []) {
            const attrs = flattenAttributes(logRecord.attributes || []);

            // Check if this is a wide event
            if (attrs['log.type'] === 'wide_event' || logRecord.body?.stringValue?.includes('[WIDE_EVENT]')) {
              const traceId = logRecord.traceId ? hexToUuid(logRecord.traceId) : null;
              const operationType = attrs['graphql.operation_type'] as string || null;
              const fieldName = attrs['graphql.field_name'] as string || null;
              const outcome = attrs['outcome'] as string || 'unknown';
              const durationMsRaw = (attrs as any)['duration.total_ms'];
              const durationMsNum = durationMsRaw === undefined || durationMsRaw === null ? null : Number(durationMsRaw);
              const durationMs = durationMsNum !== null && Number.isFinite(durationMsNum) ? durationMsNum : null;
              const userId = attrs['user.id'] as string || null;
              const errorCount = Number((attrs as any)['error_count'] ?? 0) || 0;
              const rpcCallCount = Number((attrs as any)['count.rpc_calls'] ?? 0) || 0;

              const attributes = JSON.stringify(attrs);

              rows.push({
                drop_id: dropId,
                trace_id: traceId,
                service_name: String(serviceName ?? 'unknown'),
                operation_type: operationType,
                field_name: fieldName,
                outcome: String(outcome ?? 'unknown'),
                duration_ms: durationMs,
                user_id: userId,
                error_count: errorCount,
                rpc_call_count: rpcCallCount,
                attributes,
              });

              if (broadcastBuf) {
                broadcastBuf.push({
                  drop_id: dropId,
                  trace_id: traceId,
                  service_name: String(serviceName ?? 'unknown'),
                  operation_type: operationType,
                  field_name: fieldName,
                  outcome: String(outcome ?? 'unknown'),
                  duration_ms: durationMs,
                  user_id: userId,
                  error_count: errorCount,
                  rpc_call_count: rpcCallCount,
                  attributes,
                  created_at: createdAt,
                });
              }
            }
          }
        }
      }
    }

    if (rows.length > 0) {
      insertWideEventRows(rows);
    }

    // Broadcast to connected clients (capped + batched).
    if (broadcastBuf && broadcastBuf.size() > 0) {
      const data = broadcastBuf.toArray();
      for (let i = 0; i < data.length; i += batchSize) {
        broadcast({ type: 'wide_events', drop_id: dropId, data: data.slice(i, i + batchSize) }, dropId);
      }
    }

    res.status(200).json({ partialSuccess: {} });
  } catch (error) {
    console.error('Error processing OTLP logs:', error);
    res.status(500).json({ error: 'Failed to process logs' });
  }
});

function extractServiceName(resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> }): string {
  if (!resource?.attributes) return 'unknown';
  const serviceAttr = resource.attributes.find(a => a.key === 'service.name');
  return serviceAttr?.value?.stringValue || 'unknown';
}

function hexToUuid(hex: string): string {
  if (!hex || hex.length !== 32) return hex || 'unknown';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function flattenAttributes(attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } }>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (attr.value.stringValue !== undefined) {
      result[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      result[attr.key] = parseInt(attr.value.intValue, 10);
    } else if (attr.value.boolValue !== undefined) {
      result[attr.key] = attr.value.boolValue;
    } else if (attr.value.doubleValue !== undefined) {
      result[attr.key] = attr.value.doubleValue;
    }
  }
  return result;
}
