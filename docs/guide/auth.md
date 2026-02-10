# Auth

Raphael can run fully open for local debugging, or with auth enabled for shared/public deployments.

## Local Mode (No Auth)

By default, auth is disabled and everything is available.

## Enable Auth

Set:
- `RAPHAEL_AUTH_ENABLED=true`

When auth is enabled:
- admin-only actions stay admin-only (clear all data, create drops, manage users)

## GitHub OAuth

Raphael supports GitHub OAuth sign-in when auth is enabled.

You will need:
- `RAPHAEL_AUTH_GITHUB_CLIENT_ID`
- `RAPHAEL_AUTH_GITHUB_CLIENT_SECRET`

The callback URL is derived from your `BETTER_AUTH_BASE_URL`.

