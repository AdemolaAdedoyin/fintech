# Local, development and production operations

## Local first

Requirements: Node.js 22+, npm 10+, Docker with Compose, Git. Run `npm ci` for host tooling.
`npm run local:setup` creates `.env` only if absent, mode 0600, with independent random JWT,
webhook encryption, mock signing and metrics secrets. An existing `.env` is never overwritten.
Enable `PAYMENT_PROVIDER=mock` with its private signing secret for a fully offline payment demo.

```sh
npm run local:setup
API_PORT=3001 npm run local:up
API_PORT=3001 npm run local:smoke
docker compose logs --tail=100 api worker
npm run local:down
```

The API binds loopback; port 3001 avoids colliding with another app on 3000. PostgreSQL
and Redis bind loopback ports 5433 and 6380. The smoke test creates two synthetic accounts
and permanent ledger records; it does not delete data. `local:down` preserves named volumes.
Do not use `down -v` on data you want to keep. Interactive docs are at port 3001 `/docs`.

For hot reload, start PostgreSQL/Redis with Docker then run `npm run start:dev` and
`npm run start:worker:dev` in separate terminals. Bootstrap stops Compose API/worker to
avoid duplicate consumers; it applies migrations before watching source. The native API
uses `PORT` from `.env`, not the Compose-only `API_PORT` mapping. Do not run multiple
stacks against the same host ports. Never point tests at a valued development database:
E2E creates immutable accounting records and some tests deliberately exercise invalid writes.

## Health and monitoring

Liveness `/api/v1/health/live` checks only the process. Readiness `/api/v1/health/ready`
checks PostgreSQL and Redis. Dependency failures are sanitized 503 responses. Configure
connection/pool timeouts in database URLs and an upstream timeout; do not restart every
process on a short dependency outage. Readiness does not prove payment-provider availability.

Set a private `METRICS_TOKEN` of at least 32 characters. Scrape `/api/v1/health/metrics`
with a bearer token over loopback or HTTPS/private networking; absent configuration returns
503 and an invalid token returns 401. Metrics contain aggregate counts, no customer labels.

| Metric | Meaning and initial alert |
| --- | --- |
| `fintech_notification_unpersisted` | Outbox events without a persisted notification, including published jobs; sustained growth or nonzero after queue drain requires investigation. |
| `fintech_outbox_pending` | Pending/processing outbox rows; sustained growth for 5 minutes warrants investigation. |
| `fintech_webhook_failed` | Terminal failed webhook deliveries; any increase warrants checking recipient/attempt history. |
| `fintech_payment_pending` | Pending intents, including abandoned checkouts; use trends and reconciliation, not an immediate page for every pending intent. |
| `fintech_worker_poll_age_seconds` | Age of last successful notification poll; -1 means no recent heartbeat. Alert on -1 or > max(60 seconds, twice configured poll interval). |
| `fintech_process_uptime_seconds` | API uptime; unexpected resets indicate a crash/restart loop. |

Heartbeat describes polling, not proof that all queue jobs completed. Inspect BullMQ failed
notification jobs and database notifications alongside the counters. Webhook worker health
is inferred from delivery backlog/attempts and its logs; it does not share the heartbeat.
Add external readiness probes, HTTP 5xx/latency alerts at your reverse proxy, disk/CPU/memory,
PostgreSQL connections/locks, Redis memory/evictions, backup freshness and provider status
when selecting hosting. Baseline thresholds under representative load before enabling paging.
This repository exposes monitoring signals; it does not provision an always-on monitoring service.

## Failure recovery

- Database down: readiness becomes unhealthy; restore connectivity, inspect DB logs and locks,
  then verify readiness. Never manually repair balances by updating wallet rows.
- Redis down: authentication fails closed, readiness is unhealthy, and notification publishing
  retries. Worker error handlers contain dependency errors. Restore Redis and check outbox and
  notification delivery. Redis is queue infrastructure, not the ledger source of truth.
- Published outbox without notification: inspect the BullMQ `notifications` queue, failed jobs,
  and `Notification.outboxEventId`. Replay through the domain worker/notification service after
  diagnosis; persistence is idempotent. Do not infer delivery solely from PUBLISHED status.
- Webhook failures: inspect stored safe attempt codes and recipient TLS/DNS health. Expired leases
  recover automatically; terminal failed deliveries need explicit operational investigation.
- Payment uncertainty: retain reference and Idempotency-Key, reconcile via the owner API, then
  investigate in the provider dashboard. Do not delete claims or initialize a replacement blindly.
- Shutdown: send SIGTERM and allow a grace period. In-flight queue jobs can recover after restart;
  ledger transactions remain atomic. Test recovery after dependency interruption before deployment.

## Development/production runtime preparation (not a deployment)

`docker-compose.yml` is for local development with local-only credentials and services.
`docker-compose.production.yml` is a standalone runtime definition requiring external PostgreSQL,
Redis and private environment values; it does not create a host, TLS certificate or database.
Validate privately with `docker compose --env-file /private/path/runtime.env -f
 docker-compose.production.yml config --quiet`. Never print resolved Compose config with secrets.
Use image digests and an approved release artifact in your deployment pipeline.

Production runtime runs as a non-root image user with a read-only filesystem, temporary `/tmp`,
no Linux capabilities, no privilege escalation, bounded logs and graceful shutdown. Swagger is
off and payments default disabled. Use an HTTPS reverse proxy and explicit CORS origins. Both
API and worker need the same stable encryption key. Back up that key separately from data.

Use distinct migration and runtime DB identities: the migrator owns schema changes; runtime
must not be superuser, database owner, or able to disable triggers. Grant only required schema,
table and sequence access after migrations. Application write-context settings protect against
accidental misuse, not a malicious actor with direct database credentials. Restrict DB/Redis
network access, use TLS as supported by your service, and configure statement/pool timeouts.

The app deliberately does not trust `X-Forwarded-For`. Behind a reverse proxy, all auth requests
through that proxy share its socket-IP limit. Apply trusted per-client edge rate limits and size
limits, and restrict direct backend access. Do not casually turn on `trust proxy=true`; any future
proxy configuration must name the exact trusted topology and add spoofing tests. Current limits
protect login/register only; edge limits are required for whole-service abuse protection.

Do not set `NODE_ENV=production` on the local mock profile: production rejects mock payments.
Use production mode with payments disabled to rehearse the hardened configuration. Paystack
live activation, a deploy destination, backups, restore rehearsal, load testing, external alerts,
credentials and test-account acceptance remain explicit release prerequisites.

## Backup / rollback

Take encrypted PostgreSQL backups and rehearse restoring into a separate database. Preserve
Redis persistence/queue data to minimize delivery recovery work. Keep the webhook encryption key
and secret references in your secret manager. Verify restored ledger invariants and notification
counts before using a restored environment. Application rollback must use a version compatible
with the current schema; migrations are additive and there is no automatic destructive down path.
Do not roll back posted transactions: use compensating domain operations. No backup service,
restore schedule or live rollback has been executed by this readiness phase.
