# Troubleshooting

## I Don't See Any Data

Common causes:
- you are sending to the wrong port (default is `6274`)
- you are routing ingest to a drop you are not currently viewing
- your payload format is not OTLP HTTP JSON for traces

## I Can't Sign In

Check:
- `BETTER_AUTH_BASE_URL` matches the externally reachable URL
- your OAuth app callback URL matches the same base URL

