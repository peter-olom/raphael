# Raphael

**The Watcher Who Heals**

A lightweight, local trace and wide event viewer for debugging distributed systems. Raphael watches over your services and helps you diagnose issues with real-time telemetry visualization.

## Features

- **OpenTelemetry Compatible** - Accepts OTLP HTTP JSON traces
- **Wide Events** - First-class support for structured business events
- **Real-time Updates** - WebSocket-powered live streaming
- **Zero Configuration** - Works with any service that can send HTTP requests
- **SQLite Storage** - Persistent, lightweight, no external dependencies
- **Search** - Query traces and events by service, operation, user, or attributes

## Quick Start

### Using Docker (Recommended)

```bash
docker compose up -d
```

Raphael will be available at `http://localhost:6274`

### Using Node.js

```bash
npm install
npm run dev
```

## Endpoints

| Endpoint | Method | Format | Description |
|----------|--------|--------|-------------|
| `/v1/traces` | POST | OTLP JSON | Ingest OpenTelemetry traces |
| `/v1/events` | POST | JSON | Ingest wide events (simple format) |
| `/v1/logs` | POST | OTLP JSON | Ingest wide events (OTLP logs format) |

### Sending Traces (OTLP Format)

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

### Sending Wide Events (Simple Format)

```bash
curl -X POST http://localhost:6274/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "trace_id": "abc-123",
    "service.name": "api-gateway",
    "graphql.operation_type": "query",
    "graphql.field_name": "getUsers",
    "outcome": "success",
    "duration.total_ms": 150,
    "user.id": "user-456",
    "error_count": 0,
    "count.rpc_calls": 3
  }'
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/traces` | GET | List recent traces |
| `/api/events` | GET | List recent wide events |
| `/api/traces/:traceId` | GET | Get all spans and events for a trace |
| `/api/search/traces?q=` | GET | Search traces |
| `/api/search/events?q=` | GET | Search wide events |
| `/api/stats` | GET | Get counts for traces, events, and errors |
| `/api/clear` | DELETE | Clear all data |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `6274` | Server port |
| `RAPHAEL_DB_PATH` | `./data/raphael.db` | SQLite database path |

## Tech Stack

- **Backend**: Node.js, Express, better-sqlite3, WebSocket
- **Frontend**: React 19, Vite
- **Database**: SQLite with WAL mode

## Roadmap

- [x] **Smart Filtering** - Refine log filter UX with auto-detection of high-cardinality fields (50+ entries) to generate filter options, while preserving selected filters as logs stream in
- [x] **Enhanced Viewers** - Code editor-style JSON view for traces and events with collapsible blocks
- [ ] **Dashboards** - One-click dashboard creation from logs with full drag, drop, and resize support (in progress: dashboard generator + UI builder)
- [x] **Drops** - Workspace/container separation layer to isolate logs from different environments (e.g., staging vs production)
- [x] **Auto-Truncation Rules** - Minimal retention rules per Drop to prevent unbounded growth (e.g., "Drop A: traces 3d, events 7d")
- [ ] **Auth Layer** - Optional authentication via BetterAuth for hosted deployments, with API key generation (R/W permissions per Drop per endpoint)

## Drops & Retention

- **Drops** isolate telemetry streams (e.g., `staging` vs `production`). Select/create Drops in the UI.
- Ingestion endpoints support selecting a Drop by name via the `X-Raphael-Drop` header (or `?drop=` query param).
- Each Drop has independent retention rules (defaults: traces **3 days**, events **7 days**) configurable in the UI.

## Dashboards (Preview)

- Dashboards are stored **per Drop** and can be edited in the UI builder.
- “Generate” builds a dashboard by studying field cardinality in the **last N wide events**.
- Optional AI generator: set `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL`) and enable “Use AI” in the generator modal.

## License

MIT
