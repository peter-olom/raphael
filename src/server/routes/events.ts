import { holdIngestRequest, normalizedIngestBudget } from '../ingestAdmission.js';
import { enqueueTelemetry, IngestUnavailable } from '../durableIngest.js';
import { maintenanceActive, retryMaintenance } from '../maintenanceGate.js';
import { snapshotDrop, snapshotReady } from '../maintenanceSnapshot.js';
import { telemetryTimestamp, nanosTimestamp } from '../maintenanceConfig.js';
import { Router, Request, Response } from 'express';
import { resolveDropId, type WideEventInsertRow } from '../db/sqlite.js';
import { authEnabled, noteApiKeyUsageDrop, requireAuth, requireDropAccess } from '../auth.js';
import { checkIngestRateLimit } from '../ingestRateLimit.js';

export const eventsRouter = Router();

function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function ingestMaxItems() {
  return parsePositiveInt(process.env.RAPHAEL_INGEST_MAX_ITEMS, 5000);
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
eventsRouter.post('/v1/events', async (req: Request, res: Response) => {
  const releaseIngest = holdIngestRequest(req);
  try {
    if (!requireAuth(req, res)) return;
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
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const maxItems = ingestMaxItems();
    if (events.length > maxItems) {
      res.status(413).json({ error: `Too many events in one request (max ${maxItems})` });
      return;
    }
    if (!checkIngestRateLimit(req, res, events.length)) return;

    const rows: WideEventInsertRow[] = [];
    const withinBudget = normalizedIngestBudget();

    const createdAt = Date.now();

    for (const event of events as WideEvent[]) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return res.status(400).json({ error: 'Each event must be an object' });
      for (const key of ['trace_id', 'service.name', 'graphql.operation_type', 'graphql.field_name', 'outcome', 'user.id']) {
        const value = event[key];
        if (value != null && (typeof value === 'object' || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) return res.status(400).json({ error: `Invalid scalar event field: ${key}` });
      }
      for (const key of ['duration.total_ms', 'error_count', 'count.rpc_calls']) {
        const value = event[key];
        if (value != null && (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)))) return res.status(400).json({ error: `Invalid numeric event field: ${key}` });
      }
      let sourceTime: number;
      try { sourceTime = telemetryTimestamp(event.timestamp, createdAt); } catch (error) { return res.status(400).json({ error: (error as Error).message }); }
      const traceId = event.trace_id == null ? null : String(event.trace_id);
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
        telemetry_time: sourceTime,
        created_at: createdAt,
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
      if (!withinBudget(rows[rows.length - 1])) return res.status(413).json({ error: 'Normalized telemetry exceeds 10 MiB; split the batch' });

    }

    if (rows.length > 0) {
      const maxItems = ingestMaxItems();
      if (rows.length > maxItems) {
        res.status(413).json({ error: `Too many wide events in one request (max ${maxItems})` });
        return;
      }
      await enqueueTelemetry({ traces: [], events: rows, ...(req.auth?.apiKey ? { audit: {
        api_key_id: req.auth.apiKey.id, drop_id: dropId, method: req.method, path: req.path,
        status_code: 200, ip_address: req.ip || null, user_agent: req.header('user-agent') || null,
      } } : {}) }, createdAt);
    }

    res.status(200).json({ received: events.length });
  } catch (error) {
    if (error instanceof IngestUnavailable) return retryMaintenance(res, error.message);
    if (/^SQLITE_(BUSY|LOCKED|FULL|IOERR)/.test(String((error as any)?.code || ''))) return retryMaintenance(res, 'Database unavailable; retry shortly');
    console.error('Error processing wide events:', error);
    res.status(500).json({ error: 'Failed to process events' });
  } finally { releaseIngest(); }
});

// Also support OTLP logs format (for compatibility with existing WideEventEmitter)
eventsRouter.post('/v1/logs', async (req: Request, res: Response) => {
  const releaseIngest = holdIngestRequest(req);
  try {
    if (!requireAuth(req, res)) return;
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
    const body = req.body;
    const recordCount = countLogRecords(body);
    const maxItems = ingestMaxItems();
    if (recordCount > maxItems) {
      res.status(413).json({ error: `Too many log records in one request (max ${maxItems})` });
      return;
    }
    if (!checkIngestRateLimit(req, res, recordCount)) return;

    const rows: WideEventInsertRow[] = [];
    const withinBudget = normalizedIngestBudget();

    const createdAt = Date.now();

    let rejected = 0;
    if (body.resourceLogs) {
      for (const resourceLog of body.resourceLogs) {
        const serviceName = extractServiceName(resourceLog.resource);

        for (const scopeLog of resourceLog.scopeLogs || []) {
          for (const logRecord of scopeLog.logRecords || []) {
            if (serviceName === null || !logRecord || (logRecord.traceId != null && typeof logRecord.traceId !== 'string')) { rejected++; continue; }
            let attrs: Record<string, unknown>;
            try { attrs = flattenAttributes(logRecord.attributes || []); } catch { rejected++; continue; }
            if (['duration.total_ms', 'error_count', 'count.rpc_calls'].some((key) => attrs[key] != null && !Number.isFinite(Number(attrs[key])))) { rejected++; continue; }

            let sourceTime: number;
            try { sourceTime = nanosTimestamp(logRecord.timeUnixNano && String(logRecord.timeUnixNano) !== '0' ? logRecord.timeUnixNano : logRecord.observedTimeUnixNano, createdAt); } catch { rejected++; continue; }
            {
              attrs['otel.log.attributes'] = logRecord.attributes ?? [];
              attrs['otel.log.span_id'] = logRecord.spanId ?? null;
              attrs['otel.log.flags'] = logRecord.flags ?? null;
              attrs['otel.log.body'] = logRecord.body ?? null;
              attrs['otel.log.severity_text'] = logRecord.severityText ?? null;
              attrs['otel.log.severity_number'] = logRecord.severityNumber ?? null;
              attrs['otel.resource'] = resourceLog.resource ?? null;
              attrs['otel.scope'] = scopeLog.scope ?? null;
              const traceId = logRecord.traceId ? hexToUuid(logRecord.traceId) : null;
              const operationType = attrs['graphql.operation_type'] == null ? null : String(attrs['graphql.operation_type']);
              const fieldName = attrs['graphql.field_name'] == null ? null : String(attrs['graphql.field_name']);
              const outcome = attrs['outcome'] as string || 'unknown';
              const durationMsRaw = (attrs as any)['duration.total_ms'];
              const durationMsNum = durationMsRaw === undefined || durationMsRaw === null ? null : Number(durationMsRaw);
              const durationMs = durationMsNum !== null && Number.isFinite(durationMsNum) ? durationMsNum : null;
              const userId = attrs['user.id'] == null ? null : String(attrs['user.id']);
              const errorCount = Number((attrs as any)['error_count'] ?? 0) || 0;
              const rpcCallCount = Number((attrs as any)['count.rpc_calls'] ?? 0) || 0;

              const attributes = JSON.stringify(attrs);

              rows.push({
                telemetry_time: sourceTime,
                created_at: createdAt,
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
              if (!withinBudget(rows[rows.length - 1])) return res.status(413).json({ error: 'Normalized telemetry exceeds 10 MiB; split the batch' });

            }
          }
        }
      }
    }

    if (rows.length > 0) {
      const maxItems = ingestMaxItems();
      if (rows.length > maxItems) {
        res.status(413).json({ error: `Too many wide events in one request (max ${maxItems})` });
        return;
      }
      await enqueueTelemetry({ traces: [], events: rows, ...(req.auth?.apiKey ? { audit: {
        api_key_id: req.auth.apiKey.id, drop_id: dropId, method: req.method, path: req.path,
        status_code: 200, ip_address: req.ip || null, user_agent: req.header('user-agent') || null,
      } } : {}) }, createdAt);
    }

    res.status(200).json({ partialSuccess: rejected > 0 ? { rejectedLogRecords: rejected } : {} });
  } catch (error) {
    if (error instanceof IngestUnavailable) return retryMaintenance(res, error.message);
    if (/^SQLITE_(BUSY|LOCKED|FULL|IOERR)/.test(String((error as any)?.code || ''))) return retryMaintenance(res, 'Database unavailable; retry shortly');
    console.error('Error processing OTLP logs:', error);
    res.status(500).json({ error: 'Failed to process logs' });
  } finally { releaseIngest(); }
});

function extractServiceName(resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> }): string | null {
  if (!resource?.attributes) return 'unknown';
  const serviceAttr = resource.attributes.find(a => a.key === 'service.name');
  const value = serviceAttr?.value?.stringValue;
  return value == null ? 'unknown' : typeof value === 'string' ? value : null;
}

function countLogRecords(body: any) {
  let count = 0;
  for (const resourceLog of body?.resourceLogs || []) {
    for (const scopeLog of resourceLog.scopeLogs || []) {
      count += scopeLog.logRecords?.length ?? 0;
    }
  }
  return count;
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
