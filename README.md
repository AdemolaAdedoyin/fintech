# Fintech Transaction Platform

A production-style backend project for wallets, transfers, ledger accounting, reversals, and payment infrastructure.

This repository is being rebuilt from the original JavaScript/MySQL fintech API and selected concepts from the experimental `riseBeta` repository. The modernization is intentionally phased so each layer can be reviewed before the next one is added.

## Modernization status

### Phase 1 — secure platform foundation ✅

- NestJS + TypeScript application foundation
- PostgreSQL + Prisma
- deterministic Docker and Docker Compose setup
- fail-fast environment validation
- structured JSON logging with sensitive-field redaction
- Helmet security headers and explicit CORS configuration
- Swagger/OpenAPI documentation
- liveness and PostgreSQL readiness endpoints
- graceful application shutdown hooks
- strict linting, formatting, type checking, unit tests, build checks, dependency audit, container validation, and CI smoke test

### Phase 2 — identity and wallets ✅

- atomic account registration plus initial wallet creation
- canonical, unique email identities
- scrypt password hashing using Node's crypto implementation
- short-lived HS256 JWT access tokens with explicit issuer and audience validation
- protected `/auth/me` identity lookup
- ownership-scoped wallet APIs that never trust caller-supplied user IDs
- one wallet per supported currency (`USD`, `NGN`)
- `BIGINT` minor-unit balance snapshots exposed safely as strings in JSON
- explicit zero-balance wallet closing instead of arbitrary status mutation
- PostgreSQL constraints and Prisma migration history
- PostgreSQL-backed end-to-end tests

### Phase 3 — ledger core ✅

The accounting layer is implemented without exposing a public money-mutation endpoint:

- a separate `LedgerAccount` model so customer wallets and internal/system accounts are not conflated
- one wallet-kind ledger account behind every product wallet
- internal USD and NGN external-clearing accounts for future provider/funding flows
- immutable `LedgerTransaction` and `LedgerPosting` history
- signed `BIGINT` minor-unit postings that must sum to zero
- exact PostgreSQL signed-`BIGINT` bounds enforced for postings and resulting balance snapshots
- single-currency ledger transactions
- sealed transactions that cannot receive later postings
- serializable database transactions and deterministic row locking
- non-negative customer wallet balances while explicitly designated system accounts may go negative
- wallet balance snapshots updated only through the ledger write path
- a transaction-local ledger-write context that blocks accidental direct Prisma creation/sealing of ledger history outside the internal write path
- database triggers that block direct balance mutation and edits/deletes to posted ledger history
- deferred PostgreSQL constraints that independently reject unsealed, unbalanced, cross-currency, or orphaned wallet-ledger records at commit time
- wallet closing serialized against ledger postings so a zero-balance close cannot race with a credit or debit
- concurrency coverage proving competing debits cannot overspend one wallet and close-vs-credit races resolve to one coherent state

`LedgerService` remains an internal domain service. There is no public arbitrary ledger, funding, or balance-adjustment endpoint.

### Phase 4 — internal transfers, idempotency, and beneficiaries ✅

The first public money-movement workflow is built directly on the Phase 3 ledger rather than introducing a second balance-update path:

- authenticated internal transfers between active wallets
- source-wallet ownership derived from the verified JWT identity
- same-currency transfers only; v1 performs no FX conversion
- positive `BIGINT` minor-unit amounts represented as strings at the API boundary
- `Transfer` as the product/business record and `LedgerTransaction` as the accounting record
- one serializable PostgreSQL transaction for the transfer intent, double-entry postings, wallet snapshots, and idempotency outcome
- deterministic ledger-account locks before balance validation and mutation
- required persistent `Idempotency-Key` records scoped to the authenticated user and transfer operation
- request hashing so reuse of the same key with different request data returns `409 Conflict`
- exact replay of successful requests without creating another transfer or ledger transaction
- persisted deterministic 4xx failures so adding funds later cannot turn the same failed request/key into a new movement
- transient PostgreSQL serialization conflicts surfaced as retryable `409 Conflict` responses
- concurrency coverage proving two simultaneous $80 transfers from a $100 wallet cannot both succeed
- concurrent same-key coverage proving retries deduplicate to one transfer
- completed transfer rows protected from direct mutation and independently checked against the exact sealed two-posting ledger transaction at commit
- idempotency claims must start `IN_PROGRESS`; request identity is immutable and terminal `COMPLETED`/`FAILED` records cannot be rewritten or deleted
- saved beneficiaries scoped to the authenticated owner
- soft deletion for beneficiaries so removing a saved recipient does not erase historical transfer links

### Phase 5 — reversals and audit ✅

Reversals preserve the immutable accounting model instead of editing or deleting the original transfer:

- a reversal is a separate `TransferReversal` record linked one-to-one to the original completed transfer
- the original `Transfer` remains `COMPLETED` and its ledger history remains immutable
- every reversal creates a new sealed ledger transaction with the exact opposite postings and the exact original amount/currency
- only the authenticated original sender can reverse the transfer
- both wallets must still be active; frozen or closed wallets require an operational lifecycle resolution before reversal so compliance restrictions are not bypassed and funds are not credited into an unusable closed wallet
- the original transfer row is locked before reversal eligibility is checked, so competing reversal requests cannot compensate the same transfer twice
- the existing non-negative customer-balance rule applies to reversals; if the recipient has already spent the funds, the reversal fails instead of forcing the recipient wallet negative
- reversal requests require their own persisted `Idempotency-Key`, normalized request hash, successful replay behavior, payload-mismatch protection, and immutable terminal outcome
- deterministic failed reversals remain failed for the same idempotency key even if wallet balances later change
- `AuditLog` records are append-only and capture both `TRANSFER_CREATED` and `TRANSFER_REVERSED` business events, including backfilled creation events for transfers that predate Phase 5
- reversal rows and audit rows are protected against direct update/delete operations
- deferred PostgreSQL integrity checks independently verify that a reversal exactly compensates its original transfer and has one matching reversal audit event
- E2E concurrency coverage proves simultaneous reversal attempts result in exactly one compensating ledger transaction

Phase 5 remains synchronous. Redis/BullMQ, transactional outbox dispatch, notifications, and retryable webhook delivery belong to Phase 6.

## Planned phases

1. **Foundation** — NestJS, TypeScript, PostgreSQL, Prisma, Docker, configuration, logging, Swagger, health checks, CI. ✅
2. **Identity and wallets** — registration/login, ownership authorization, wallet lifecycle, minor-unit money representation. ✅
3. **Ledger core** — immutable ledger transactions/postings, balance invariants, atomic database transactions. ✅
4. **Transfers** — internal transfers, idempotency, concurrency protection, beneficiaries. ✅
5. **Reversals and audit** — compensating ledger entries, reversal rules, audit history. ✅
6. **Async infrastructure** — Redis/BullMQ, outbox processing, notifications, retryable webhook delivery.
7. **Provider abstraction** — mock provider first, optional tokenized/hosted Paystack integration with verified webhooks.
8. **Production polish** — deployment, observability, expanded security testing, architecture documentation.

After the useful RiseBeta concepts are represented safely in this project, `riseBeta` will be archived as an earlier experimental iteration.

## Public API available through Phase 5

| Method   | Route                                    | Purpose                                                                                   |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/auth/register`                  | Register and create the first wallet atomically                                           |
| `POST`   | `/api/v1/auth/login`                     | Authenticate and issue a short-lived bearer token                                         |
| `GET`    | `/api/v1/auth/me`                        | Return the authenticated user profile                                                     |
| `POST`   | `/api/v1/wallets`                        | Create another supported-currency wallet                                                  |
| `GET`    | `/api/v1/wallets`                        | List wallets owned by the authenticated user                                              |
| `GET`    | `/api/v1/wallets/:walletId`              | Read one owned wallet                                                                     |
| `POST`   | `/api/v1/wallets/:walletId/close`        | Close an owned zero-balance wallet                                                        |
| `POST`   | `/api/v1/transfers`                      | Create an idempotent same-currency internal transfer                                      |
| `GET`    | `/api/v1/transfers`                      | List transfers initiated by the authenticated user                                        |
| `GET`    | `/api/v1/transfers/:transferId`          | Read one transfer initiated by the authenticated user                                     |
| `POST`   | `/api/v1/transfers/:transferId/reversal` | Create an idempotent compensating reversal                                                |
| `GET`    | `/api/v1/transfers/:transferId/reversal` | Read the owned transfer's reversal                                                        |
| `GET`    | `/api/v1/audit?limit=50&cursor=...`      | Page through immutable transfer/reversal audit events performed by the authenticated user |
| `POST`   | `/api/v1/beneficiaries`                  | Save another user's active wallet as a beneficiary                                        |
| `GET`    | `/api/v1/beneficiaries`                  | List active saved beneficiaries                                                           |
| `DELETE` | `/api/v1/beneficiaries/:beneficiaryId`   | Soft-delete a saved beneficiary                                                           |
| `GET`    | `/api/v1/health/live`                    | Process liveness                                                                          |
| `GET`    | `/api/v1/health/ready`                   | PostgreSQL readiness                                                                      |

Swagger is available at `/docs` and documents the transfer/reversal `Idempotency-Key` headers and request DTOs.

### Creating an internal transfer

`POST /api/v1/transfers` requires an authenticated bearer token and an `Idempotency-Key` header. The request must identify the sender's source wallet and exactly one destination form: either a direct `destinationWalletId` or a saved `beneficiaryId`.

```http
POST /api/v1/transfers
Authorization: Bearer <access-token>
Idempotency-Key: transfer-2026-09-11-001
Content-Type: application/json
```

```json
{
  "sourceWalletId": "11111111-1111-4111-8111-111111111111",
  "destinationWalletId": "22222222-2222-4222-8222-222222222222",
  "amountMinor": "2500"
}
```

The amount is always expressed in minor units. For USD, `"2500"` represents `$25.00`. Successful retries with the same key and identical normalized request return the existing transfer instead of moving money again. Reusing the same key with a different request returns `409 Conflict`.

A serialization conflict caused by another concurrent transfer also returns `409 Conflict`; retry that request with the **same** idempotency key. Because the conflicting database transaction did not commit, the retry can safely establish or replay the final result.

### Reversing an internal transfer

`POST /api/v1/transfers/:transferId/reversal` requires the original sender's bearer token and a separate `Idempotency-Key`. An optional reason may be supplied for operational context.

```http
POST /api/v1/transfers/33333333-3333-4333-8333-333333333333/reversal
Authorization: Bearer <access-token>
Idempotency-Key: reversal-2026-09-11-001
Content-Type: application/json
```

```json
{
  "reason": "Duplicate payment"
}
```

A reversal does not rewrite the original transfer. It creates a second immutable ledger transaction that credits the original source account and debits the original destination account for the same amount. Both wallets must remain active. If either wallet is inactive or the destination wallet no longer has enough funds, the request returns `409 Conflict` and no partial reversal is committed. Retrying a deterministic failed reversal with the same idempotency key returns the stored failure even if wallet state later changes.

## Ledger model

A product wallet is not itself the accounting record. Each wallet owns one wallet-kind ledger account, while system accounts represent internal counterparts such as external clearing.

```text
Wallet
  currentBalanceMinor (read snapshot)
        |
        v
LedgerAccount (WALLET)
        |
        +---- LedgerPosting -10000
        |
        +---- LedgerPosting +2500

LedgerTransaction
  reference
  currency
  sealedAt
        |
        +---- LedgerPosting(account A, -2500)
        +---- LedgerPosting(account B, +2500)
```

A valid transaction must have at least two non-zero postings, use one currency, and sum exactly to zero. Once sealed, the transaction and its postings are immutable. Customer wallet accounts may never become negative. Posting values and resulting account balances must remain within PostgreSQL's signed `BIGINT` range.

For internal wallet transfers, the source and destination wallet ledger accounts are the two posting accounts. The transfer row and ledger transaction share the same unique reference, and a deferred PostgreSQL integrity check independently verifies the source debit and destination credit match the transfer amount exactly.

A reversal uses a new ledger transaction with the opposite postings rather than editing those original entries:

```text
Original transfer
Source wallet                 -2500
Destination wallet            +2500
                              -----
                                  0

Compensating reversal
Source wallet                 +2500
Destination wallet            -2500
                              -----
                                  0
```

For future external funding, an internal clearing account can be the counterpart:

```text
External clearing (system)   -10000
Customer wallet              +10000
                              ------
                                   0
```

This lets provider integrations arrive later without inventing or directly editing wallet balances.

## Money representation

All balances and postings use PostgreSQL `BIGINT` values in the smallest currency unit. For example, `$10.25` is represented internally as `1025` cents and `₦5,000.00` as `500000` kobo.

Because JavaScript numbers cannot safely represent every 64-bit integer, public wallet, transfer, and reversal responses serialize monetary minor-unit values as decimal strings. Internal ledger arithmetic uses JavaScript `bigint`.

## Local setup

### Requirements

- Node.js 22+
- npm 10+
- Docker Desktop with Docker Compose

The recommended development topology is **PostgreSQL in Docker + NestJS running locally in watch mode**. The repository also includes a Dockerized API for production-style/container testing, but you normally do not run that API container while actively developing locally.

### First-time setup

Create your environment file:

```bash
cp .env.example .env
```

Replace `JWT_ACCESS_SECRET` with a private random value of at least 32 characters. The application rejects both weak secrets and the documented example placeholder.

The default host-side database URL is:

```env
DATABASE_URL=postgresql://fintech:fintech_dev@localhost:5433/fintech?schema=public
```

Install dependencies:

```bash
npm ci
```

Then start the entire local development environment with one command:

```bash
npm run start:dev
```

`start:dev` performs the local bootstrap automatically:

1. stops the Docker `api` service if it was previously running, preventing a port `3000` conflict;
2. starts PostgreSQL in Docker in detached mode and waits for its health check;
3. generates the Prisma client;
4. runs `prisma migrate deploy` — Prisma applies only pending committed migrations and does nothing when the database is already current;
5. starts NestJS locally in watch mode.

After `npm ci`, you therefore normally only need:

```bash
npm run start:dev
```

The development topology is:

```text
Host machine
├── NestJS API                 localhost:3000
│
└── Docker
    └── PostgreSQL             localhost:5433 -> container:5432
```

Stopping NestJS with `Ctrl+C` does not stop PostgreSQL. PostgreSQL was started in detached mode and continues running for the next development session.

Useful database commands:

```bash
# Check container health and published ports
docker compose ps

# Stop only PostgreSQL
docker compose stop postgres

# Start the existing PostgreSQL container again
docker compose start postgres

# Stop/remove Compose containers and network while preserving database data
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete the local PostgreSQL volume and all local database data.

### Why is there also a Docker `api` service?

The Docker API is the same NestJS application packaged as a production-style container. It exists for reproducibility and deployment parity: it proves the API can build and run without depending on a developer's local Node environment, lets CI validate the production container, and provides a complete containerized stack for deployment-style testing.

For everyday coding, local NestJS watch mode is more convenient. Use one API mode at a time:

- **Local development:** PostgreSQL in Docker + `npm run start:dev` for NestJS locally.
- **Full Docker:** PostgreSQL + migrations + API all run in Compose.

### Full Docker mode

To run the entire stack through Docker instead of running Nest locally:

```bash
docker compose up -d --build
```

Compose starts PostgreSQL, waits for it to become healthy, applies committed Prisma migrations through the one-shot `migrate` service, and then starts the Docker API.

In full Docker mode, do **not** also run `npm run start:dev`. The Docker API already owns host port `3000`.

Docker containers use the Compose service hostname rather than the host-published port:

```text
postgresql://fintech:fintech_dev@postgres:5432/fintech?schema=public
```

That is intentionally different from the local NestJS URL (`localhost:5433`). Do not change the Docker-internal URL to `localhost`.

To switch back to local development, simply run:

```bash
npm run start:dev
```

The bootstrap step stops the Docker API, keeps/starts PostgreSQL, applies any pending migrations, and launches Nest locally.

Service URLs when either API mode is running:

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/api/v1/health/live`
- Readiness: `http://localhost:3000/api/v1/health/ready`

### Database migrations

`npm run start:dev` runs `prisma migrate deploy` every time before Nest starts. This is safe and idempotent: Prisma records applied migrations in `_prisma_migrations`, applies only migrations that have not yet run, and reports `No pending migrations to apply` when the database is current.

You can still invoke migrations manually when needed:

```bash
npm run db:migrate:deploy
```

The PostgreSQL container must be running for a host-side migration command to work.

### Common startup errors

| Error                                                  | Usually means                                                                                  | Fix                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `P1001: Can't reach database server at localhost:5433` | PostgreSQL is stopped                                                                          | Run `npm run start:dev` or start it manually with `docker compose up -d --wait postgres`                 |
| `P1000: Authentication failed`                         | Your `.env` does not match the Fintech database or you reached a different PostgreSQL instance | Confirm `DATABASE_URL` uses `fintech:fintech_dev@localhost:5433/fintech` and inspect `docker compose ps` |
| `Can't reach database server at postgres:5432`         | A Docker API/migration container was started without the Compose PostgreSQL service            | Start the stack through `docker compose up -d --build` rather than running the API image by itself       |
| `EADDRINUSE ... 0.0.0.0:3000`                          | Another process already owns port `3000`, commonly the Docker API                              | `npm run start:dev` now stops the Compose API first; otherwise inspect the process using port `3000`     |

A quick health check after startup is:

```bash
docker compose ps
curl http://localhost:3000/api/v1/health/ready
```

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run prisma:validate
npm run build
npm run db:migrate:deploy
npm run test:e2e
```

GitHub Actions performs a production dependency audit, validates the Prisma schema, applies migrations against a real PostgreSQL service, runs PostgreSQL-backed domain E2E tests, validates the Compose definition, builds both migration and production container targets from the committed lockfile, and starts the compiled API to verify database readiness.

## Security and integrity baseline

The rebuilt service follows these rules from the beginning:

- required secrets fail validation instead of falling back to committed defaults;
- the documented example JWT secret is explicitly rejected;
- passwords are hashed with scrypt and plaintext passwords are never persisted;
- JWT verification constrains algorithm, issuer, audience, expiry, and authenticated user existence;
- authorization headers, cookies, idempotency keys, passwords, and token-like fields are redacted from structured logs;
- authenticated wallet ownership comes from the verified token identity rather than request-provided user IDs;
- duplicate email and duplicate per-currency wallet constraints are enforced in PostgreSQL as well as the service layer;
- wallet balances cannot be changed directly through application code outside the guarded ledger write context;
- ledger transaction/posting creation and transaction sealing require the transaction-local ledger write context;
- ledger postings and sealed ledger transactions cannot be updated or deleted;
- PostgreSQL independently verifies balanced, sealed, single-currency ledger transactions at commit;
- new wallet ledger accounts must begin at zero and be paired with exactly one matching product wallet by commit;
- ledger accounts are locked in deterministic order before balance checks and updates;
- wallet close operations take the same ledger-account lock used by financial postings;
- transfer source ownership is checked against the authenticated user and independently rechecked by a deferred database constraint;
- completed transfers are immutable and must reference the exact matching sealed ledger debit/credit transaction;
- transfer and reversal retries require persisted idempotency keys and normalized request hashes;
- terminal idempotency outcomes cannot be rewritten or deleted;
- reversals are immutable compensating events and must reference an exact matching sealed opposite ledger transaction;
- only the original transfer sender may own its reversal, and a transfer can be reversed at most once;
- audit history is append-only and deferred database checks bind transfer/reversal audit events to their owning actor and resource;
- beneficiaries are owner-scoped and soft-deleted so transfer history remains referentially intact;
- raw card PAN/CVV/PIN handling will not be part of the rebuilt payment flow;
- user-controlled values are not concatenated into SQL;
- the production container runs as a non-root user and installs dependencies from the committed lockfile.

The transaction-local ledger-write, transfer-write, reversal-write, and audit-write settings are application/database integrity guards against accidental bypasses by normal application code. They are not intended to be security boundaries against an administrator with full PostgreSQL privileges; a production deployment with that threat model would add database-role separation and tighter privilege controls.

## Historical context

The original project provided user registration, authentication, wallet funding, payouts, beneficiaries, and external payment-provider integrations. RiseBeta later experimented with transaction history, reversals, USD wallets, plans, and portfolio-style calculations.

The rebuild keeps the useful product ideas while replacing the legacy runtime, floating-point money handling, direct balance mutation, tightly coupled payment-provider logic, and outdated security patterns.
