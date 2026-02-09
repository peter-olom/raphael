# Repository Guidelines

## Project Structure & Module Organization

- `src/server/`: Node.js (ESM) Express API, OTLP ingestion, query endpoints, WebSocket streaming, auth, and SQLite access.
  - `src/server/routes/`: Route groups (e.g. `api.ts`, `otlp.ts`, `query.ts`, `admin.ts`).
  - `src/server/db/`: SQLite schema and queries (`sqlite.ts`).
- `src/client/`: Vite + React UI (Vite `root` is `src/client`).
  - `src/client/public/`: Static assets served by Vite/build.
- `data/`: Local SQLite file by default (`./data/raphael.db`) and Docker volume mount target.
- `dist/`: Build output (`dist/server/*`, `dist/client/*`).

## Build, Test, and Development Commands

Prefer Docker for the full stack:

```bash
docker compose up -d --build
docker compose logs -f raphael
```

Local Node dev (two processes: server + client):

```bash
npm install
npm run dev
```

- `npm run dev`: `tsx watch` server on `:6274` plus Vite dev server (proxying `/api` and `/ws`).
- `npm run build`: Typecheck/compile (`tsc`) and build the client (`vite build`) into `dist/`.
- `npm run start`: Run the compiled server (`node dist/server/index.js`).
- `npm run preview`: Build then start (quick production-like check).

Note: the repo currently includes `package-lock.json`; use `npm` unless you are intentionally migrating package management in the same change.

## Coding Style & Naming Conventions

- TypeScript `strict` is enabled; keep changes type-safe.
- Match existing formatting: 2-space indent, single quotes, semicolons.
- Node ESM imports use `.js` extensions in TS (e.g. `import ... from './routes/api.js'`).
- Types/interfaces `PascalCase`; files typically `camelCase.ts` or feature-named (e.g. `dashboardGenerator.ts`).

## Testing Guidelines

There is no formal test suite yet. For every change, do at least:

- `npm run build`
- Smoke checks: `curl http://localhost:6274/api/stats` and one ingest/query path you touched (see `README.md`).

## Commit & Pull Request Guidelines

- Commit subjects in history are short, imperative, and occasionally use `feat:` (conventional-commit style). Follow that pattern.
- PRs should describe behavior changes, include screenshots/GIFs for UI changes, and call out any new env vars (especially auth-related like `RAPHAEL_AUTH_*` and `BETTER_AUTH_*`).

