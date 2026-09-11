# Fintech Transaction Platform

A production-style backend project for wallets, transfers, ledger accounting, reversals, and payment infrastructure.

This repository is being rebuilt from the original JavaScript/MySQL fintech API and selected concepts from the experimental `riseBeta` repository. The modernization is intentionally phased so each layer can be reviewed before the next one is added.

## Modernization status

### Phase 1 — secure platform foundation

Current branch scope:

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

Domain behavior such as authentication, wallets, ledger postings, transfers, idempotency, and reversals is intentionally **not implemented yet**. Those are added in later reviewed phases.

## Planned phases

1. **Foundation** — NestJS, TypeScript, PostgreSQL, Prisma, Docker, configuration, logging, Swagger, health checks, CI.
2. **Identity and wallets** — registration/login, ownership authorization, wallet lifecycle, minor-unit money representation.
3. **Ledger core** — immutable ledger transactions/postings, balance invariants, atomic database transactions.
4. **Transfers** — internal transfers, idempotency, concurrency protection, beneficiaries.
5. **Reversals and audit** — compensating ledger entries, reversal rules, audit history.
6. **Async infrastructure** — Redis/BullMQ, outbox processing, notifications, retryable webhook delivery.
7. **Provider abstraction** — mock provider first, optional tokenized/hosted Paystack integration with verified webhooks.
8. **Production polish** — deployment, observability, expanded security testing, architecture documentation.

After the useful RiseBeta concepts are represented safely in this project, `riseBeta` will be archived as an earlier experimental iteration.

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

Replace `JWT_ACCESS_SECRET` with a private random value of at least 32 characters. The application rejects both weak secrets and the documented example placeholder.

### Run with Docker Compose

```bash
docker compose up --build
```

This starts:

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/api/v1/health/live`
- Readiness: `http://localhost:3000/api/v1/health/ready`
- PostgreSQL: `localhost:5432` (bound to the local host only)

Both PostgreSQL and the API have container health checks. The API waits for PostgreSQL to be healthy before starting.

### Run the API locally with PostgreSQL in Docker

```bash
docker compose up postgres -d
npm ci
npm run prisma:generate
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
```

GitHub Actions also performs a production dependency audit, validates the Compose definition, builds the production Docker image from the committed lockfile, and starts the compiled API against a real PostgreSQL service to verify the readiness endpoint.

## Security baseline

The rebuilt service follows a few rules from the beginning:

- required secrets fail validation instead of falling back to committed defaults;
- the documented example JWT secret is explicitly rejected;
- authorization headers, cookies, passwords, and token-like fields are redacted from structured logs;
- the API applies secure HTTP headers through Helmet;
- CORS is configured from an explicit allowlist;
- request validation is strict and rejects unknown fields;
- raw card PAN/CVV/PIN handling will not be part of the rebuilt payment flow;
- user-controlled values will not be concatenated into SQL;
- the production container runs as a non-root user and installs dependencies from the committed lockfile.

## Historical context

The original project provided user registration, authentication, wallet funding, payouts, beneficiaries, and external payment-provider integrations. RiseBeta later experimented with transaction history, reversals, USD wallets, plans, and portfolio-style calculations.

The rebuild keeps the useful product ideas while replacing the legacy runtime, floating-point money handling, direct balance mutation, tightly coupled payment-provider logic, and outdated security patterns.
