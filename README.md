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

There is intentionally no `POST /ledger`, funding endpoint, transfer endpoint, or arbitrary balance-adjustment endpoint in Phase 3. `LedgerService` is an internal domain service. Phase 4 will build controlled transfer/idempotency behavior on top of it.

## Planned phases

1. **Foundation** — NestJS, TypeScript, PostgreSQL, Prisma, Docker, configuration, logging, Swagger, health checks, CI. ✅
2. **Identity and wallets** — registration/login, ownership authorization, wallet lifecycle, minor-unit money representation. ✅
3. **Ledger core** — immutable ledger transactions/postings, balance invariants, atomic database transactions. ✅
4. **Transfers** — internal transfers, idempotency, concurrency protection, beneficiaries.
5. **Reversals and audit** — compensating ledger entries, reversal rules, audit history.
6. **Async infrastructure** — Redis/BullMQ, outbox processing, notifications, retryable webhook delivery.
7. **Provider abstraction** — mock provider first, optional tokenized/hosted Paystack integration with verified webhooks.
8. **Production polish** — deployment, observability, expanded security testing, architecture documentation.

After the useful RiseBeta concepts are represented safely in this project, `riseBeta` will be archived as an earlier experimental iteration.

## Public API available through Phase 3

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Register and create the first wallet atomically |
| `POST` | `/api/v1/auth/login` | Authenticate and issue a short-lived bearer token |
| `GET` | `/api/v1/auth/me` | Return the authenticated user profile |
| `POST` | `/api/v1/wallets` | Create another supported-currency wallet |
| `GET` | `/api/v1/wallets` | List wallets owned by the authenticated user |
| `GET` | `/api/v1/wallets/:walletId` | Read one owned wallet |
| `POST` | `/api/v1/wallets/:walletId/close` | Close an owned zero-balance wallet |
| `GET` | `/api/v1/health/live` | Process liveness |
| `GET` | `/api/v1/health/ready` | PostgreSQL readiness |

Swagger is available at `/docs`.

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

Because JavaScript numbers cannot safely represent every 64-bit integer, public wallet responses serialize `currentBalanceMinor` as a decimal string. Internal ledger arithmetic uses JavaScript `bigint`.

## Local setup

### Requirements

- Node.js 22+
- npm 10+
- Docker Desktop (recommended)

### Environment

```bash
cp .env.example .env
```

Replace `JWT_ACCESS_SECRET` with a private random value of at least 32 characters. The application rejects both weak secrets and the documented example placeholder. `JWT_ACCESS_TTL_SECONDS` defaults to 900 seconds.

### Run with Docker Compose

```bash
docker compose up --build
```

Compose starts PostgreSQL, applies committed Prisma migrations through the one-shot `migrate` service, and only then starts the API.

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/api/v1/health/live`
- Readiness: `http://localhost:3000/api/v1/health/ready`
- PostgreSQL: `localhost:5432` (bound to the local host only)

### Run the API locally with PostgreSQL in Docker

```bash
docker compose up postgres -d
npm ci
npm run prisma:generate
npm run db:migrate:deploy
npm run start:dev
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
- authorization headers, cookies, passwords, and token-like fields are redacted from structured logs;
- authenticated wallet ownership comes from the verified token identity rather than request-provided user IDs;
- duplicate email and duplicate per-currency wallet constraints are enforced in PostgreSQL as well as the service layer;
- wallet balances cannot be changed directly through application code outside the guarded ledger write context;
- ledger transaction/posting creation and transaction sealing require the transaction-local ledger write context;
- ledger postings and sealed ledger transactions cannot be updated or deleted;
- PostgreSQL independently verifies balanced, sealed, single-currency ledger transactions at commit;
- new wallet ledger accounts must begin at zero and be paired with exactly one matching product wallet by commit;
- ledger accounts are locked in deterministic order before balance checks and updates;
- wallet close operations take the same ledger-account lock used by financial postings;
- raw card PAN/CVV/PIN handling will not be part of the rebuilt payment flow;
- user-controlled values are not concatenated into SQL;
- the production container runs as a non-root user and installs dependencies from the committed lockfile.

The transaction-local ledger-write setting is an application/database integrity guard against accidental bypasses by normal application code. It is not intended to be a security boundary against an administrator with full PostgreSQL privileges; a production deployment with that threat model would add database-role separation and tighter privilege controls.

## Historical context

The original project provided user registration, authentication, wallet funding, payouts, beneficiaries, and external payment-provider integrations. RiseBeta later experimented with transaction history, reversals, USD wallets, plans, and portfolio-style calculations.

The rebuild keeps the useful product ideas while replacing the legacy runtime, floating-point money handling, direct balance mutation, tightly coupled payment-provider logic, and outdated security patterns.