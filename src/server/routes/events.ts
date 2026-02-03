import { Router, Request, Response } from 'express';
import { ensureDrop, insertWideEventRow } from '../db/sqlite.js';
import { broadcast } from '../websocket.js';

export const eventsRouter = Router();

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
  try {
    const dropId = ensureDrop((req.header('x-raphael-drop') || (req.query.drop as string) || '').toString());
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const insertedEvents: unknown[] = [];

    for (const event of events as WideEvent[]) {
      const traceId = event.trace_id || null;
      const serviceName = event['service.name'] || 'unknown';
      const operationType = event['graphql.operation_type'] || null;
      const fieldName = event['graphql.field_name'] || null;
      const outcome = event.outcome || 'unknown';
      const durationMs = event['duration.total_ms'] || null;
      const userId = event['user.id'] || null;
      const errorCount = event.error_count || 0;
      const rpcCallCount = event['count.rpc_calls'] || 0;
      const attributes = JSON.stringify(event);

      insertWideEventRow(
        dropId,
        traceId,
        serviceName,
        operationType,
        fieldName,
        outcome,
        durationMs,
        userId,
        errorCount,
        rpcCallCount,
        attributes
      );

      insertedEvents.push({
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
        created_at: Date.now(),
      });
    }

    // Broadcast to connected clients
    if (insertedEvents.length > 0) {
      broadcast({ type: 'wide_events', drop_id: dropId, data: insertedEvents }, dropId);
    }

    res.status(200).json({ received: events.length });
  } catch (error) {
    console.error('Error processing wide events:', error);
    res.status(500).json({ error: 'Failed to process events' });
  }
});

// Also support OTLP logs format (for compatibility with existing WideEventEmitter)
eventsRouter.post('/v1/logs', (req: Request, res: Response) => {
  try {
    const dropId = ensureDrop((req.header('x-raphael-drop') || (req.query.drop as string) || '').toString());
    const body = req.body;
    const insertedEvents: unknown[] = [];

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
              const durationMs = attrs['duration.total_ms'] as number || null;
              const userId = attrs['user.id'] as string || null;
              const errorCount = attrs['error_count'] as number || 0;
              const rpcCallCount = attrs['count.rpc_calls'] as number || 0;

              insertWideEventRow(
                dropId,
                traceId,
                serviceName,
                operationType,
                fieldName,
                outcome,
                durationMs,
                userId,
                errorCount,
                rpcCallCount,
                JSON.stringify(attrs)
              );

              insertedEvents.push({
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
                attributes: JSON.stringify(attrs),
                created_at: Date.now(),
              });
            }
          }
        }
      }
    }

    // Broadcast to connected clients
    if (insertedEvents.length > 0) {
      broadcast({ type: 'wide_events', drop_id: dropId, data: insertedEvents }, dropId);
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
