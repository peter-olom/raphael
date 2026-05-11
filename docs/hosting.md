# Hosting Raphael

This guide describes a simple Docker setup for running Raphael on a server with a minimal runtime image, reduced container privileges, and basic operational notes.

## Goals

- Minimal runtime image (no shell, no package manager)
- Runs as non-root
- Read-only root filesystem
- No Linux capabilities, no privilege escalation
- Writable data isolated to a single volume mount (`/data`)
- Clear guidance for auth, OAuth callbacks, and reverse proxying

## Build and Run (Docker Compose)

Raphael ships with a `Dockerfile` and `docker-compose.yml` that aim to be safe defaults.

```bash
docker compose up -d --build
docker compose logs -f raphael
```

Data persists in a named volume mounted at `/data` inside the container.

For compatibility with older Compose deployments, the app publishes on all interfaces unless `RAPHAEL_HOST_BIND` is set. Use `RAPHAEL_HOST_BIND=127.0.0.1` for same-host reverse proxies or local-only installs. Publish on all interfaces only when the deployment has auth, TLS, and a trusted network boundary.

Raphael trusts loopback reverse proxies by default so `X-Forwarded-For` is used for client IP decisions when a same-host proxy connects locally. If your trusted proxy reaches Raphael over another private network, set `RAPHAEL_TRUST_PROXY` to the exact proxy subnet or hop count. Only enable broader proxy trust when the app is not directly reachable and the proxy overwrites forwarded headers.

If you are upgrading from an older Raphael version that wrote the DB under `/app/data`, the volume may be root-owned. The included `raphael-init` service fixes volume permissions at startup so the main container can stay non-root.

## Container Image (GHCR)

If you are using the public GitHub repo, CI publishes a multi-arch image to GHCR:
- `ghcr.io/<owner>/<repo>:latest` (default branch)
- `ghcr.io/<owner>/<repo>:<sha>` and branch/tag variants

If the package ends up private by default, set it to public in GitHub Packages settings for the repo/package.

## Required Environment

At minimum:
- `PORT` (default: `6274`)
- `RAPHAEL_DB_PATH` (default in container: `/data/raphael.db`)

### Auth (Recommended For Any Public Deployment)

Enable auth:
- `RAPHAEL_AUTH_ENABLED=true`

For public deployments, set:
- `BETTER_AUTH_SECRET` (32+ chars)
- `BETTER_AUTH_BASE_URL` (the externally reachable base URL, e.g. `https://raphael.example.com`)
- `RAPHAEL_AUTH_TRUSTED_ORIGINS` (comma-separated origins allowed to initiate auth, typically the same as the base URL)
- `RAPHAEL_CORS_ORIGINS` if browser clients need cross-origin API access
- `RAPHAEL_ADMIN_EMAIL` so first-admin bootstrap is explicit

If you enable email/password login:
- `RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED=true`
- `RAPHAEL_ADMIN_EMAIL` and `RAPHAEL_ADMIN_PASSWORD` for seeding/updating the admin password

If you are using OAuth providers, configure the provider env vars and ensure their callback URLs match `BETTER_AUTH_BASE_URL`.

In production, unauthenticated admin mutations are denied unless `RAPHAEL_ALLOW_UNAUTH_ADMIN=true`. Do not enable that flag for public deployments.

### OAuth Allowlist (Optional, OAuth-Only Mode)

If auth is enabled and email/password is disabled (`oauth_only` mode), admins can configure:
- allowed email domains and/or explicit emails
- default drop permissions for newly created OAuth member users

This is managed in the UI under `Settings -> Auth` or via:
- `GET /api/admin/auth-policy`
- `PUT /api/admin/auth-policy`

## Reverse Proxy (TLS)

Raphael can be run behind a reverse proxy for TLS termination and basic request hygiene.

Recommended proxy hardening:
- TLS (Let’s Encrypt)
- reasonable request body limits (OTLP payloads can be large)
- edge rate limiting if exposed to the internet
- overwrite `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`

Raphael also enforces local ingest rate limits before writes:
- `RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE` (default `600`)
- `RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE` (default `60000`)
- `RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER` (default `2`)
- `RAPHAEL_TRUST_PROXY` (default `loopback`; set to a trusted subnet or hop count for non-loopback proxies)

If you already have an ingress/proxy, point it at `raphael:6274`.

## Container Hardening Details

The default `docker-compose.yml` applies:
- `read_only: true` (root filesystem is read-only)
- `tmpfs` for `/tmp` with `noexec,nosuid`
- `cap_drop: [ALL]`
- `security_opt: no-new-privileges:true`
- `init: true` (reaps zombies)
- `pids_limit`

The runtime image is distroless (Debian), which removes:
- interactive shell
- package managers
- common utilities used for post-exploitation

### Persistent Storage

Only `/data` is writable. The DB lives at:
- `RAPHAEL_DB_PATH=/data/raphael.db`

If you change `RAPHAEL_DB_PATH`, keep it under `/data` unless you also update the compose volume mounts.

## Operational Checklist

1. Keep the base image fresh.
- Rebuild regularly to pull security updates (`docker compose build --pull`).

2. Keep dependencies fresh.
- Prefer automated dependency PRs (Dependabot/Renovate).

3. Monitor auth configuration.
- Ensure `BETTER_AUTH_BASE_URL` is correct.
- Keep `RAPHAEL_AUTH_TRUSTED_ORIGINS` tight.
- Keep first-admin bootstrap explicit with `RAPHAEL_ADMIN_EMAIL`.

4. Reduce exposure.
- Put Raphael behind a proxy.
- Consider IP allowlisting for internal-only deployments.
- Keep the default localhost bind unless the proxy is on another host.
- Keep `RAPHAEL_TRUST_PROXY` scoped to the actual trusted proxy path.

5. Strong isolation (Optional).
- Run under gVisor/Kata if your platform supports it for tighter syscall isolation.

6. Retention and compaction.
- Retention pruning automatically checkpoints and reclaims SQLite free pages by default.
- Keep `RAPHAEL_PRUNE_COMPACT_AFTER_DELETE=true` unless write-lock duration becomes a problem.
- For older databases that were not created with incremental vacuum, Raphael runs full VACUUM only after the configured free-page threshold is reached.
