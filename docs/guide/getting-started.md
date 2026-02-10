# Getting Started

Raphael is a lightweight, local trace and wide event viewer for debugging distributed systems.

## Run With Docker

```bash
docker compose up -d --build
docker compose logs -f raphael
```

Open:
- `http://localhost:6274`

## Run With Node.js

```bash
npm install
npm run dev
```

This starts:
- server on `http://localhost:6274`
- Vite dev client (proxied to the server)

## Where Data Lives

By default, Raphael stores data in SQLite.

In Docker Compose it writes to:
- `/data/raphael.db` (mounted via the `raphael-data` volume)

