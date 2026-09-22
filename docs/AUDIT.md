# Readiness audit — 2026-09-21

Scope: source review, dependency audit, ledger invariants, local Docker operation, security
regressions, API specification and operational preparation. This is an engineering readiness
review, not an independent penetration test or financial/compliance certification. No production
deployment, live payment activation or real-account charge was performed.

## Findings addressed

| Finding | Resolution / evidence |
| --- | --- |
| Readiness omitted Redis | Readiness now checks both dependencies; outage test verifies sanitized 503 and independent liveness. |
| No shared login/register rate limit | Atomic expiring Redis counters, 429/Retry-After, fail closed on outage, forwarded-IP spoofing test. |
| Notification poll rejection could escape timer | Recovery handler, explicit Redis/queue error handlers, sanitized errors, tracked in-flight poll on shutdown, outage/recovery regression. |
| No protected operational metrics | Separate bearer secret, aggregate outbox/payment/webhook counts, notification persistence gap and worker poll age; unauthorized reads tested before database access. |
| Docker probe used localhost IPv6 against IPv4 listener | Probe now uses 127.0.0.1; full local Compose reaches healthy state. |
| Production/local configuration conflated | Separate external-service production runtime, non-root/read-only/capability restrictions, docs off, explicit HTTPS CORS validation, local loopback binding. |
| Manual setup and undocumented acceptance | Private non-overwriting setup, end-to-end local smoke, API guide/OpenAPI export, operations/architecture and Paystack acceptance guides. |

## Verification

- 97 unit tests and 85 PostgreSQL/Redis E2E tests, including money races, immutable history,
  signature verification, owner scoping, SSRF transport, callback replay, authentication limits
  and dependency failure paths.
- Formatting, ESLint, TypeScript, Prisma validation and application build.
- Production dependency audit: zero known vulnerabilities at this check; rerun in CI because advisories change.
- Fresh migrations and read-only ledger audit: zero unbalanced/unsealed transactions,
  account/wallet snapshot mismatches, posting currency mismatches or successful payments missing ledger evidence.
- Complete Docker local smoke: registration, mock funding, callback replay, transfer, reversal,
  expected final balance, dependency readiness and asynchronous notification persistence.
- Hardened production-mode container rehearsed locally: dependency readiness 200, Swagger/UI and JSON disabled (404), unauthenticated metrics 401, Helmet headers present, read-only filesystem/capabilities restricted.
- OpenAPI generated from controllers; CI checks that the checked-in export is current.

Run `DATABASE_URL=<private connection supplied via environment> npm run audit:ledger` with a
read-only-capable identity. It uses one read-only repeatable-read transaction, a query timeout,
and prints aggregate failures only. A failure is a stop-and-investigate signal, never permission
to update balances directly. This aggregate audit supplements, rather than replaces, the detailed
deferred database constraints and domain tests.

## Outstanding external acceptance / release gates

1. Paystack test-account authentication, hosted checkout completion and real signed webhook replay.
   No test key was configured in the existing repository environment; see [acceptance procedure](PAYSTACK.md).
2. Hosting-specific TLS/proxy topology, whole-service edge limits, secrets, non-owner runtime DB grants,
   backup restore rehearsal, resource/load testing and external alert routing.
3. Operational plans for lost initialization responses, closed-wallet external payments, failed jobs,
   provider reconciliation and key rotation. Current recovery boundaries are documented; automatic
   checkout URL recovery, payouts, refunds and disputes are not implemented.
4. Product launch needs remain outside this backend readiness scope: account recovery/verification,
   admin/operator roles, consumer notification APIs, compliance review and independent security testing
   where required by the intended product.

Local core workflows are verifiable without Paystack or public hosting. Production configuration
is prepared, but these release gates must be resolved before calling a real-money deployment ready.
