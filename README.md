# Fintech Transaction Platform

A production-style backend project for wallets, transfers, ledger accounting, reversals, and payment infrastructure.

This repository is being rebuilt from the original JavaScript/MySQL fintech API and selected concepts from the experimental `riseBeta` repository. The modernization is intentionally phased so each layer can be reviewed before the next one is added.

## Modernization status

### Phase 1 — secure platform foundation ✅

Completed foundation:

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

### Phase 2 — identity and wallets

Current branch adds the first domain layer:

- atomic account registration plus initial wallet creation
- canonical, unique email identities
- scrypt password hashing using Node's crypto implementation
- short-lived HS256 JWT access tokens with explicit issuer and audience validation
- protected `/auth/me` identity lookup
- ownership-scoped wallet APIs that never trust caller-supplied user IDs
- one wallet per supported currency (`USD`, `NGN`)
- `BIGINT` minor-unit balance snapshots exposed safely as strings in JSON
- explicit zero-balance wallet closing instead of arbitrary status mutation
- Prisma migration history for the identity/wallet schema
- PostgreSQL-backed end-to-end tests for registration, login, authorization, wallet uniqueness, and wallet lifecycle
- a dedicated migration container that applies schema changes before the local API starts

No funding, ledger postings, transfers, balance mutation API, idempotency, reversals, or payment-provider integrations are implemented in Phase 2. Those remain intentionally deferred so money movement is introduced only after the ledger invariants are designed and reviewed.

## Planned phases

1. **Foundation** — NestJS, TypeScript, PostgreSQL, Prisma, Docker, configuration, logging, Swagger, health checks, CI. ✅
2. **Identity and wallets** — registration/login, ownership authorization, wallet lifecycle, minor-unit money representation.
3. **Ledger core** — immutable ledger transactions/postings, balance invariants, atomic database transactions.
4. **Transfers** — internal transfers, idempotency, concurrency protection, beneficiaries.
5. **Reversals and audit** — compensating ledger entries, reversal rules, audit history.
6. **Async infrastructure** — Redis/BullMQ, outbox processing, notifications, retryable webhook delivery.
7. **Provider abstraction** — mock provider first, optional tokenized/hosted Paystack integration with verified webhooks.
8. **Production polish** — deployment, observability, expanded security testing, architecture documentation.

After the useful RiseBeta concepts are represented safely in this project, `riseBeta` will be archived as an earlier experimental iteration.

## API available in Phase 2

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

## Money representation

Balances are stored as PostgreSQL `BIGINT` values in the smallest currency unit. For example, `$10.25` is represented internally as `1025` cents and `₦5,000.00` as `500000` kobo.

Because JavaScript numbers cannot safely represent every 64-bit integer, API responses serialize `currentBalanceMinor` as a decimal string. Phase 2 only initializes balances to zero; actual balance changes will be introduced through the ledger in Phase 3 rather than through direct wallet mutation endpoints.

## Local setup

### Requirements

- Node.js 22+
- npm 10+
- Docker Desktop (recommended)

### Environment

Copy the example file:

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

GitHub Actions performs a production dependency audit, validates the Prisma schema, applies migrations against a real PostgreSQL service, runs the identity/wallet end-to-end suite, validates the Compose definition, builds both migration and production container targets from the committed lockfile, and starts the compiled API to verify database readiness.

## Security baseline

The rebuilt service follows these rules from the beginning:

- required secrets fail validation instead of falling back to committed defaults;
- the documented example JWT secret is explicitly rejected;
- passwords are hashed with scrypt and plaintext passwords are never persisted;
- JWT verification constrains algorithm, issuer, audience, expiry, and authenticated user existence;
- authorization headers, cookies, passwords, and token-like fields are redacted from structured logs;
- authenticated wallet ownership comes from the verified token identity rather than request-provided user IDs;
- duplicate email and duplicate per-currency wallet constraints are enforced in PostgreSQL as well as the service layer;
- the API applies secure HTTP headers through Helmet;
- CORS is configured from an explicit allowlist;
- request validation is strict and rejects unknown fields;
- raw card PAN/CVV/PIN handling will not be part of the rebuilt payment flow;
- user-controlled values will not be concatenated into SQL;
- the production container runs as a non-root user and installs dependencies from the committed lockfile.

## Historical context

The original project provided user registration, authentication, wallet funding, payouts, beneficiaries, and external payment-provider integrations. RiseBeta later experimented with transaction history, reversals, USD wallets, plans, and portfolio-style calculations.

The rebuild keeps the useful product ideas while replacing the legacy runtime, floating-point money handling, direct balance mutation, tightly coupled payment-provider logic, and outdated security patterns.
