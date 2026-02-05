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
| `/v1/query/traces` | POST | JSON | Query traces (rich filters) |
| `/v1/query/events` | POST | JSON | Query wide events (rich filters) |
| `/v1/query/traces/:traceId` | GET | JSON | Get all spans and events for a trace |

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
| `/api/auth/config` | GET | Auth configuration summary for the UI |
| `/api/auth/*` | POST/GET | BetterAuth endpoints (sign-in, callbacks, sessions) |
| `/api/admin/*` | GET/POST/PATCH/DELETE | Admin endpoints (users, service accounts, API keys, usage) |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `6274` | Server port |
| `RAPHAEL_DB_PATH` | `./data/raphael.db` | SQLite database path |
| `RAPHAEL_AUTH_ENABLED` | `false` | Enable auth (sessions + API keys) |
| `RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED` | `false` | Enable email/password login |
| `RAPHAEL_ADMIN_EMAIL` | `""` | Promote this email to admin on sign-in |
| `RAPHAEL_ADMIN_PASSWORD` | `""` | Seed/update admin password (email/password only) |
| `RAPHAEL_AUTH_SESSION_TTL_HOURS` | `168` | Session duration in hours |
| `RAPHAEL_AUTH_TRUSTED_ORIGINS` | `""` | Comma-separated trusted origins for auth |
| `RAPHAEL_AUTH_GOOGLE_CLIENT_ID` | `""` | Google OAuth client id |
| `RAPHAEL_AUTH_GOOGLE_CLIENT_SECRET` | `""` | Google OAuth client secret |
| `RAPHAEL_AUTH_GITHUB_CLIENT_ID` | `""` | GitHub OAuth client id |
| `RAPHAEL_AUTH_GITHUB_CLIENT_SECRET` | `""` | GitHub OAuth client secret |
| `RAPHAEL_AUTH_AZURE_TENANT_ID` | `""` | Azure Entra tenant id |
| `RAPHAEL_AUTH_AZURE_CLIENT_ID` | `""` | Azure Entra client id |
| `RAPHAEL_AUTH_AZURE_CLIENT_SECRET` | `""` | Azure Entra client secret |
| `RAPHAEL_AUTH_GENERIC_OAUTH` | `""` | JSON array of generic OAuth providers |
| `BETTER_AUTH_SECRET` | `""` | Required in production, 32+ chars |
| `BETTER_AUTH_URL` | `""` | Base URL for OAuth callbacks |
| `BETTER_AUTH_BASE_URL` | `""` | Alternate base URL override |

## Tech Stack

- **Backend**: Node.js, Express, better-sqlite3, WebSocket
- **Frontend**: React 19, Vite
- **Database**: SQLite with WAL mode

## Roadmap

- [x] **Smart Filtering** - Refine log filter UX with auto-detection of high-cardinality fields (50+ entries) to generate filter options, while preserving selected filters as logs stream in
- [x] **Enhanced Viewers** - Code editor-style JSON view for traces and events with collapsible blocks
- [x] **Dashboards** - One-click dashboard creation from logs with full drag, drop, and resize support
- [x] **Drops** - Workspace/container separation layer to isolate logs from different environments (e.g., staging vs production)
- [x] **Auto-Truncation Rules** - Minimal retention rules per Drop to prevent unbounded growth (e.g., "Drop A: traces 3d, events 7d")
- [x] **Auth Layer** - Optional authentication for hosted deployments, with API key generation (R/W permissions per Drop per endpoint)

## Drops & Retention

- **Drops** isolate telemetry streams (e.g., `staging` vs `production`). Select/create Drops in the UI.
- Ingestion endpoints support selecting a Drop by name via the `X-Raphael-Drop` header (or `?drop=` query param).
- Each Drop has independent retention rules (defaults: traces **3 days**, events **7 days**) configurable in the UI.

## Dashboards

- Dashboards are stored **per Drop** and can be edited in the UI builder.
- “Generate” builds a dashboard by studying field cardinality in the **last N wide events**.
- Edit mode supports **drag / drop / resize**; View mode hides config knobs.
- Optional AI generator: set OpenRouter key + model in **Settings** (or via `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`) and enable “Use AI” in the generator modal.

## Auth & API Keys

Auth is disabled by default. Set `RAPHAEL_AUTH_ENABLED=true` to activate the login UI. When auth is enabled, ingestion/query endpoints require either a session cookie or an API key. When auth is disabled, ingestion/query APIs are open (no API key required).

Auth uses BetterAuth and only enables the providers you configure via environment variables. If you only enable OAuth providers, no password flow is available.

- First user to sign in becomes **admin**
- `RAPHAEL_ADMIN_EMAIL` is always promoted to admin on sign-in
- If `RAPHAEL_ADMIN_PASSWORD` changes and email/password login is enabled, the password hash is updated
- Admins manage users (admin/member), disable users, and control per-Drop `ingest`/`query` access

API keys are issued to **service accounts** and scoped per Drop with `ingest`/`query` permissions. API key creation records the admin user who created it, and API key usage is logged. Pass keys via:

```bash
Authorization: Bearer <api_key>
```

### Query API (v1)

Query traces:

```bash
curl -X POST http://localhost:6274/v1/query/traces \
  -H "Content-Type: application/json" \
  -d '{
    "drop": "default",
    "q": "checkout",
    "where": { "status": "error", "service_name": "api-gateway" },
    "range": { "start_time": { "gte": 1704067200000 } },
    "attributes": [{ "key": "http.method", "op": "eq", "value": "POST" }],
    "limit": 200
  }'
```

Query wide events:

```bash
curl -X POST http://localhost:6274/v1/query/events \
  -H "Content-Type: application/json" \
  -d '{
    "drop": "default",
    "where": { "outcome": "error" },
    "range": { "duration_ms": { "gte": 250 } },
    "attributes": [{ "key": "graphql.field_name", "op": "like", "value": "user" }]
  }'
```

The query endpoints accept rich filters:
- `q` for free-text matching
- `where` for exact field matches
- `range` for numeric/time ranges
- `attributes` for JSON attribute filters (`eq`, `like`, `gt`, `gte`, `lt`, `lte`, `exists`)
- `limit`, `offset`, and `order` for pagination

## License

MIT
