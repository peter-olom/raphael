# Drops

Drops isolate telemetry streams (for example: local vs staging vs production).

## Routing

You can route ingest and query to a drop using:
- request header: `X-Raphael-Drop: prod`
- query param: `?drop=prod`

The drop **ID** is the stable identifier used for routing and storage.

## Labels

Drops also have an optional **label** which is what the UI displays (for example: show `Production` while routing uses `prod`).

## Retention

Retention is set per drop in Settings. Saving retention triggers a prune for that drop.

## Deleting Drops

Deleting a drop permanently deletes all telemetry and saved objects in that drop.

Safeguards:
- you cannot delete the default drop
- the UI disables delete when the default drop is active

