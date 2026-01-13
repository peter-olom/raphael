import { Router, Request, Response } from 'express';
import { insertTrace } from '../db/sqlite.js';
import { broadcast } from '../websocket.js';

export const otlpRouter = Router();

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
  try {
    const body = req.body as OtlpTraceRequest;

    if (!body.resourceSpans) {
      res.status(200).json({ partialSuccess: {} });
      return;
    }

    const insertedTraces: unknown[] = [];

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

          insertTrace.run(
            traceId,
            spanId,
            parentSpanId,
            serviceName,
            operationName,
            startTime,
            endTime,
            durationMs,
            status,
            attributes
          );

          const trace = {
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
          };

          insertedTraces.push(trace);
        }
      }
    }

    // Broadcast to connected clients
    if (insertedTraces.length > 0) {
      broadcast({ type: 'traces', data: insertedTraces });
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
