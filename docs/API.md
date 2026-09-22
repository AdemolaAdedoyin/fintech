# API reference

Local base URL: `http://127.0.0.1:3000/api/v1` (or your `API_PORT`).
Interactive documentation: `/docs`; machine-readable specification: `/docs-json`.
The checked-in [OpenAPI document](openapi.json) can be imported into Postman or another
API client. Refresh it with `npm run build && npm run docs:export`. Swagger is disabled
by default for a standalone production runtime; `API_DOCS_ENABLED` explicitly overrides
that choice. The production Compose file keeps it off.

## Common contract

Use JSON request bodies. Unknown fields are rejected. UUIDs identify resources; UTC dates
are ISO strings. Monetary amounts are **positive decimal strings in minor units**, such as
`"2500"` for NGN 25.00 or USD 25.00. Never send floating-point money. Supported wallet
currencies are `USD` and `NGN`; Paystack funding currently accepts NGN only.

After register/login, send `Authorization: Bearer <accessToken>`. Access tokens expire
(default 900 seconds); log in again to obtain one. No refresh-token, email-verification,
password-reset or admin API is currently implemented. Never put tokens in query strings.
All user resources are ownership-scoped. There is no public balance-edit endpoint.

A stable `Idempotency-Key` is required for creating payments, transfers and reversals.
Reuse the original key and exact request after a timeout. Different data with the same
key returns 409. Transfers/reversals preserve deterministic failed outcomes; creating a
new key represents a new business attempt. Payment initialization never credits money.

| Status | Meaning / caller action |
| --- | --- |
| 400 | Invalid input; correct the request. |
| 401 | Missing/invalid/expired token or callback signature. |
| 404 | Resource absent or inaccessible to this user. |
| 409 | Conflict: balance/lifecycle/idempotency/settlement mismatch. Read the message; only retry transient contention with the same key. |
| 429 | Authentication rate limit; wait for `Retry-After`. |
| 503 | Dependency/provider unavailable or uncertain checkout. Reconcile the existing intent; never invent a replacement payment automatically. |

Errors use Nest's JSON shape, typically `{"statusCode":400,"message":["..."],"error":"Bad Request"}`;
readiness uses a dependency-status object. No secret or internal provider payload is part
of the contract. Examples below use placeholders, not working credentials.

## Accounts and wallets

`POST /auth/register`:

```json
{"email":"alex@example.com","password":"a-private-long-password","firstName":"Alex","lastName":"Morgan","currency":"NGN"}
```

Returns 201 with `accessToken`, `tokenType`, `expiresIn`, a safe `user` profile and
`initialWallet`. `POST /auth/login` accepts `email` and `password`, returning the same token
fields and `user` (without `initialWallet`). `GET /auth/me` returns the authenticated profile.
Register and login share a Redis-backed per-socket-IP limit, default 60 requests per minute.

`POST /wallets` accepts `{"currency":"USD"}`. One wallet per currency per user is allowed.
`GET /wallets` lists owned wallets; `GET /wallets/:walletId` returns one. Example wallet:

```json
{"id":"<uuid>","currency":"NGN","status":"ACTIVE","currentBalanceMinor":"10000","createdAt":"<ISO date>","updatedAt":"<ISO date>"}
```

`POST /wallets/:walletId/close` closes an owned zero-balance wallet. Active balances cannot
be closed. Funding/transfer settlement checks wallet lifecycle under ledger locks.

## Funding

`POST /payments` with Idempotency-Key:

```json
{"walletId":"<owned-wallet-uuid>","amountMinor":"10000"}
```

Returns a payment containing `id`, `walletId`, `provider`, `reference`, `amountMinor`,
`currency`, `status`, timestamps and `checkoutUrl` (null in mock mode). Follow a Paystack
checkout URL in a browser; a browser redirect is never proof of payment. Pending initialization
with an uncertain upstream result returns 503; find the intent with `GET /payments`.
`GET /payments/:id` returns its state; `GET /payments/:id/events` lists safe provider evidence.
`POST /payments/:id/reconcile` verifies an owned Paystack reference server-side and returns
the latest payment. Non-success provider attempts remain pending for a possible later success.

`GET /payments` and event history support `limit` (default 50, max 100) and `cursor`, returning
`{"items":[...],"nextCursor":"<uuid or null>"}`. Do not reuse another user's cursor.

Provider callbacks use separate authentication: `POST /payments/webhooks/mock` accepts
`Mock-Timestamp` and `Mock-Signature`; `POST /payments/webhooks/paystack` accepts
`x-paystack-signature`. Send exact signed bytes. Mock mode is development/test only;
Paystack uses HMAC-SHA512 and independent verification. See [Paystack acceptance](PAYSTACK.md).

## Transfers, reversals, beneficiaries and audit

`POST /transfers` with Idempotency-Key:

```json
{"sourceWalletId":"<owned-source>","destinationWalletId":"<recipient-wallet>","amountMinor":"2500"}
```

Use `beneficiaryId` instead of `destinationWalletId` for a saved beneficiary, never both.
Wallets must be active and use the same currency. Returns the completed transfer with IDs,
amount, currency and ledger reference. `GET /transfers` and `GET /transfers/:transferId`
show transfers initiated by the authenticated user.

`POST /transfers/:transferId/reversal` with a separate Idempotency-Key accepts
`{"reason":"Duplicate transfer"}`. Only the original sender can request one full reversal;
the recipient must still have sufficient funds. Original history is preserved and opposite
postings are added. `GET /transfers/:transferId/reversal` reads that reversal.

`POST /beneficiaries`, `GET /beneficiaries`, `DELETE /beneficiaries/:beneficiaryId` manage
saved recipients; see OpenAPI for the validated create fields. Deletion is soft.
`GET /audit` reads the owner's transfer/reversal audit history with cursor pagination.
Notifications are persisted internally by the worker; no notification retrieval API exists yet.

## Outbound webhooks

`POST /webhooks` registers a public HTTPS endpoint and returns its signing secret **once**.
`GET /webhooks` lists safe subscription metadata; `DELETE /webhooks/:id` disables future
work; `GET /webhooks/:id/deliveries` lists delivery/attempt history with cursor pagination.
The API and worker need the same stable `WEBHOOK_ENCRYPTION_KEY`. DNS/IP checks disallow
localhost/private targets; local testing of delivery uses the automated transport fixtures.
Do not weaken SSRF checks to send callbacks to localhost. An already in-flight request
cannot be recalled when a subscription is disabled. See README Phase 6B for signing/retry details.

## Operations

`GET /health/live` checks the process. `GET /health/ready` (also `/health`) checks PostgreSQL
and Redis, returning 503 on dependency failure. `GET /health/metrics` uses a separate
`Authorization: Bearer <METRICS_TOKEN>` and is intentionally excluded from public OpenAPI.
See [operations](OPERATIONS.md) for metric meanings and alerts.
