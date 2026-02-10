# Ingest

Raphael supports OpenTelemetry traces (OTLP HTTP JSON), plus wide events for structured business telemetry.

## Traces (OTLP HTTP JSON)

```bash
curl -X POST http://localhost:6274/v1/traces \
  -H "Content-Type: application/json" \
  -d '{
    "resourceSpans": [{
      "resource": {
        "attributes": [{"key": "service.name", "value": {"stringValue": "my-service"}}]
      },
      "scopeSpans": [{
        "spans": [{
          "traceId": "abc123...",
          "spanId": "def456...",
          "name": "GET /users",
          "startTimeUnixNano": "1704067200000000000",
          "endTimeUnixNano": "1704067200100000000"
        }]
      }]
    }]
  }'
```

## Wide Events (Simple JSON)

```bash
curl -X POST http://localhost:6274/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "trace_id": "abc-123",
    "service.name": "api-gateway",
    "operation": "checkout",
    "outcome": "success",
    "duration.total_ms": 150,
    "user.id": "user-456",
    "error_count": 0,
    "count.rpc_calls": 3
  }'
```

Tip: if you include `trace_id` on wide events, Raphael can link you directly from an event to its trace drilldown.

