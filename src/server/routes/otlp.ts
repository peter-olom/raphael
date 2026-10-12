import { holdIngestRequest, normalizedIngestBudget } from '../ingestAdmission.js';
import { enqueueTelemetry, IngestUnavailable } from '../durableIngest.js';
import { maintenanceActive, retryMaintenance } from '../maintenanceGate.js';
import { snapshotDrop, snapshotReady } from '../maintenanceSnapshot.js';
import { nanosTimestamp } from '../maintenanceConfig.js';
import { Router, Request, Response } from 'express';
import { resolveDropId, type TraceInsertRow } from '../db/sqlite.js';
import { authEnabled, noteApiKeyUsageDrop, requireAuth, requireDropAccess } from '../auth.js';
import { checkIngestRateLimit } from '../ingestRateLimit.js';

export const otlpRouter = Router();

function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function ingestMaxItems() {
  return parsePositiveInt(process.env.RAPHAEL_INGEST_MAX_ITEMS, 5000);
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
otlpRouter.post('/v1/traces', async (req: Request, res: Response) => {
  const releaseIngest = holdIngestRequest(req);
  try {
    if (!requireAuth(req, res)) return;
    const body = req.body as OtlpTraceRequest;
    const rawDrop = (req.header('x-raphael-drop') || (req.query.drop as string) || '').toString();
    const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
    const dropId = maintenanceActive() ? snapshotDrop(rawDrop) : resolveDropId(rawDrop, allowCreate);
    if (dropId === null) {
      if (maintenanceActive() && (!snapshotReady() || (allowCreate && !/^\d+$/.test(rawDrop.trim())))) return retryMaintenance(res, 'Drop lookup unavailable during maintenance; retry shortly');
      res.status(404).json({ error: 'Drop not found' });
      return;
    }
    noteApiKeyUsageDrop(req, dropId);
    if (!requireDropAccess(req, res, dropId, 'ingest')) return;

    if (!body.resourceSpans) {
      res.status(200).json({ partialSuccess: {} });
      return;
    }

    const spanCount = countSpans(body);
    const maxItems = ingestMaxItems();
    if (spanCount > maxItems) {
      res.status(413).json({ error: `Too many spans in one request (max ${maxItems})` });
      return;
    }
    if (!checkIngestRateLimit(req, res, spanCount)) return;

    const rows: TraceInsertRow[] = [];
    const withinBudget = normalizedIngestBudget();
    let rejected = 0;

    const createdAt = Date.now();

    for (const resourceSpan of body.resourceSpans) {
      const serviceName = extractServiceName(resourceSpan.resource);

      for (const scopeSpan of resourceSpan.scopeSpans || []) {
        for (const span of scopeSpan.spans || []) {
          if (serviceName === null || !span || (span.parentSpanId != null && typeof span.parentSpanId !== 'string') || typeof span.traceId !== 'string' || typeof span.spanId !== 'string' || typeof span.name !== 'string' || !span.traceId || !span.spanId || !span.name || !span.startTimeUnixNano || String(span.startTimeUnixNano) === '0') {
            rejected += 1;
            continue;
          }
          const traceId = hexToUuid(span.traceId);
          const spanId = span.spanId;
          const parentSpanId = span.parentSpanId || null;
          const operationName = span.name;
          let startTime: number | null = null;
          try { startTime = nanosTimestamp(span.startTimeUnixNano, createdAt); } catch {}
          if (startTime === null) {
            rejected += 1;
            continue;
          }
          const endTime = span.endTimeUnixNano ? nanosToMillis(span.endTimeUnixNano) : null;
          const durationMs = endTime !== null && endTime >= startTime ? endTime - startTime : null;
          const status = span.status?.code === 2 ? 'error' : 'ok';
          let attributes: string;
          try { attributes = JSON.stringify(flattenAttributes(span.attributes || [])); } catch { rejected++; continue; }

          rows.push({
            drop_id: dropId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            service_name: serviceName,
            operation_name: operationName,
            start_time: startTime,
            telemetry_time: startTime,
            created_at: createdAt,
            end_time: endTime,
            duration_ms: durationMs,
            status,
            attributes,
          });
          if (!withinBudget(rows[rows.length - 1])) return res.status(413).json({ error: 'Normalized telemetry exceeds 10 MiB; split the batch' });

        }
      }
    }

    if (rows.length > 0) {
      await enqueueTelemetry({ traces: rows, events: [], ...(req.auth?.apiKey ? { audit: {
        api_key_id: req.auth.apiKey.id, drop_id: dropId, method: req.method, path: req.path,
        status_code: 200, ip_address: req.ip || null, user_agent: req.header('user-agent') || null,
      } } : {}) }, createdAt);
    }

    res.status(200).json({ partialSuccess: rejected > 0 ? { rejectedSpans: rejected } : {} });
  } catch (error) {
    if (error instanceof IngestUnavailable) return retryMaintenance(res, error.message);
    if (/^SQLITE_(BUSY|LOCKED|FULL|IOERR)/.test(String((error as any)?.code || ''))) return retryMaintenance(res, 'Database unavailable; retry shortly');
    console.error('Error processing OTLP traces:', error);
    res.status(500).json({ error: 'Failed to process traces' });
  } finally { releaseIngest(); }
});

function countSpans(body: OtlpTraceRequest) {
  let count = 0;
  for (const resourceSpan of body.resourceSpans || []) {
    for (const scopeSpan of resourceSpan.scopeSpans || []) {
      count += scopeSpan.spans?.length ?? 0;
    }
  }
  return count;
}

function extractServiceName(resource?: OtlpResource): string | null {
  if (!resource?.attributes) return 'unknown';
  const serviceAttr = resource.attributes.find(a => a.key === 'service.name');
  const value = serviceAttr?.value?.stringValue;
  return value == null ? 'unknown' : typeof value === 'string' ? value : null;
}

function hexToUuid(hex: string): string {
  if (!hex || hex.length !== 32) return hex || 'unknown';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nanosToMillis(nanos: string): number | null {
  const parsed = Number.parseInt(nanos, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed / 1_000_000);
}

function flattenAttributes(attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } }>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (attr.value.stringValue !== undefined) {
      result[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      result[attr.key] = parseInt(attr.value.intValue, 10);
    } else if (attr.value.doubleValue !== undefined) {
      result[attr.key] = attr.value.doubleValue;
    } else if (attr.value.boolValue !== undefined) {
      result[attr.key] = attr.value.boolValue;
    }
  }
  return result;
}
