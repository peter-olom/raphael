# Auth

Raphael can run fully open for local debugging, or with auth enabled for shared/public deployments.

## Local Mode (No Auth)

By default, auth is disabled for local debugging. In production, admin mutations are blocked unless explicitly allowed.

## Enable Auth

Set:
- `RAPHAEL_AUTH_ENABLED=true`

When auth is enabled:
- admin-only actions stay admin-only (clear all data, create drops, manage users)
- first-admin bootstrap should be explicit via `RAPHAEL_ADMIN_EMAIL`
- production startup fails if there is no existing admin and no explicit admin bootstrap path

For production, set `BETTER_AUTH_SECRET`, `BETTER_AUTH_BASE_URL`, and `RAPHAEL_AUTH_TRUSTED_ORIGINS`.

## GitHub OAuth

Raphael supports GitHub OAuth sign-in when auth is enabled.

You will need:
- `RAPHAEL_AUTH_GITHUB_CLIENT_ID`
- `RAPHAEL_AUTH_GITHUB_CLIENT_SECRET`

The callback URL is derived from your `BETTER_AUTH_BASE_URL`.
