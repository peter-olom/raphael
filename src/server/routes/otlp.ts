import { Router, Request, Response } from 'express';
import { insertTraceRows, resolveDropId, type TraceInsertRow } from '../db/sqlite.js';
import { broadcast, hasSubscribers } from '../websocket.js';
import { authEnabled, noteApiKeyUsageDrop, requireAuth, requireDropAccess } from '../auth.js';

export const otlpRouter = Router();

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

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status?: { code?: number; message?: string };
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
}

interface OtlpResource {
  attributes?: Array<{ key: string; value: { stringValue?: string } }>;
}

interface OtlpScopeSpans {
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource?: OtlpResource;
  scopeSpans?: OtlpScopeSpans[];
}

interface OtlpTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

// OTLP HTTP JSON receiver for traces
otlpRouter.post('/v1/traces', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  try {
    const body = req.body as OtlpTraceRequest;
    const rawDrop = (req.header('x-raphael-drop') || (req.query.drop as string) || '').toString();
    const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
    const dropId = resolveDropId(rawDrop, allowCreate);
    if (dropId === null) {
      res.status(404).json({ error: 'Drop not found' });
      return;
    }
    noteApiKeyUsageDrop(req, dropId);
    if (!requireDropAccess(req, res, dropId, 'ingest')) return;

    if (!body.resourceSpans) {
      res.status(200).json({ partialSuccess: {} });
      return;
    }

    const rows: TraceInsertRow[] = [];

    const shouldBroadcast = hasSubscribers(dropId);
    const maxBroadcast = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_MAX_ITEMS, 500);
    const batchSize = parsePositiveInt(process.env.RAPHAEL_INGEST_BROADCAST_BATCH_SIZE, 200);
    const broadcastBuf = shouldBroadcast ? makeRingBuffer<any>(maxBroadcast) : null;

    const createdAt = Date.now();

    for (const resourceSpan of body.resourceSpans) {
      const serviceName = extractServiceName(resourceSpan.resource);

      for (const scopeSpan of resourceSpan.scopeSpans || []) {
        for (const span of scopeSpan.spans || []) {
          const traceId = hexToUuid(span.traceId);
          const spanId = span.spanId;
          const parentSpanId = span.parentSpanId || null;
          const operationName = span.name;
          const startTime = nanosToMillis(span.startTimeUnixNano);
          const endTime = span.endTimeUnixNano ? nanosToMillis(span.endTimeUnixNano) : null;
          const durationMs = endTime ? endTime - startTime : null;
          const status = span.status?.code === 2 ? 'error' : 'ok';
          const attributes = JSON.stringify(flattenAttributes(span.attributes || []));

          rows.push({
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
          });

          if (broadcastBuf) {
            broadcastBuf.push({
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
              created_at: createdAt,
            });
          }
        }
      }
    }

    if (rows.length > 0) {
      insertTraceRows(rows);
    }

    // Broadcast to connected clients (capped + batched).
    if (broadcastBuf && broadcastBuf.size() > 0) {
      const data = broadcastBuf.toArray();
      for (let i = 0; i < data.length; i += batchSize) {
        broadcast({ type: 'traces', drop_id: dropId, data: data.slice(i, i + batchSize) }, dropId);
      }
    }

    res.status(200).json({ partialSuccess: {} });
  } catch (error) {
    console.error('Error processing OTLP traces:', error);
    res.status(500).json({ error: 'Failed to process traces' });
  }
});

function extractServiceName(resource?: OtlpResource): string {
  if (!resource?.attributes) return 'unknown';
  const serviceAttr = resource.attributes.find(a => a.key === 'service.name');
  return serviceAttr?.value?.stringValue || 'unknown';
}

function hexToUuid(hex: string): string {
  if (!hex || hex.length !== 32) return hex || 'unknown';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nanosToMillis(nanos: string): number {
  return Math.floor(parseInt(nanos, 10) / 1_000_000);
}

function flattenAttributes(attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (attr.value.stringValue !== undefined) {
      result[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      result[attr.key] = parseInt(attr.value.intValue, 10);
    } else if (attr.value.boolValue !== undefined) {
      result[attr.key] = attr.value.boolValue;
    }
  }
  return result;
}
