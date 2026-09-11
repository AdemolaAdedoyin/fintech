-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('WALLET', 'SYSTEM');

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "currency" "Currency" NOT NULL,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "systemKey" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerAccount_balance_policy_check" CHECK ("allowNegative" OR "balanceMinor" >= 0),
    CONSTRAINT "LedgerAccount_kind_policy_check" CHECK (
      ("kind" = 'SYSTEM' AND "systemKey" IS NOT NULL) OR
      ("kind" = 'WALLET' AND "systemKey" IS NULL AND "allowNegative" = false)
    )
);

-- Seed internal clearing accounts. These are accounting counterparts, not customer wallets.
INSERT INTO "LedgerAccount" (
  "id", "kind", "currency", "allowNegative", "balanceMinor", "systemKey", "updatedAt"
) VALUES
  ('00000000-0000-4000-8000-000000000001', 'SYSTEM', 'USD', true, 0, 'external-clearing:USD', CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000000002', 'SYSTEM', 'NGN', true, 0, 'external-clearing:NGN', CURRENT_TIMESTAMP);

-- Add ledger-account ownership to existing wallets and preserve any historical snapshot.
ALTER TABLE "Wallet" ADD COLUMN "ledgerAccountId" UUID;

INSERT INTO "LedgerAccount" (
  "id", "kind", "currency", "allowNegative", "balanceMinor", "systemKey", "createdAt", "updatedAt"
)
SELECT
  "id", 'WALLET'::"LedgerAccountKind", "currency", false, "currentBalanceMinor", NULL, "createdAt", "updatedAt"
FROM "Wallet";

UPDATE "Wallet" SET "ledgerAccountId" = "id";
ALTER TABLE "Wallet" ALTER COLUMN "ledgerAccountId" SET NOT NULL;

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "currency" "Currency" NOT NULL,
    "description" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMPTZ(3),

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerTransaction_reference_canonical_check" CHECK (
      length(btrim("reference")) > 0 AND "reference" = btrim("reference")
    )
);

-- CreateTable
CREATE TABLE "LedgerPosting" (
    "id" UUID NOT NULL,
    "ledgerTransactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerPosting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerPosting_nonzero_amount_check" CHECK ("amountMinor" <> 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_systemKey_key" ON "LedgerAccount"("systemKey");
CREATE INDEX "LedgerAccount_currency_kind_idx" ON "LedgerAccount"("currency", "kind");
CREATE UNIQUE INDEX "Wallet_ledgerAccountId_key" ON "Wallet"("ledgerAccountId");
CREATE UNIQUE INDEX "LedgerTransaction_reference_key" ON "LedgerTransaction"("reference");
CREATE UNIQUE INDEX "LedgerPosting_ledgerTransactionId_accountId_key" ON "LedgerPosting"("ledgerTransactionId", "accountId");
CREATE INDEX "LedgerPosting_accountId_createdAt_idx" ON "LedgerPosting"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_ledgerAccountId_fkey"
  FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_ledgerTransactionId_fkey"
  FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- If this migration encounters a pre-ledger non-zero wallet, preserve it as an auditable opening balance.
INSERT INTO "LedgerTransaction" (
  "id", "reference", "currency", "description", "createdAt", "sealedAt"
)
SELECT
  md5('opening-ledger-transaction:' || w."id"::text)::uuid,
  'migration:opening:' || w."id"::text,
  w."currency",
  'Opening balance migrated into ledger',
  w."createdAt",
  CURRENT_TIMESTAMP
FROM "Wallet" w
WHERE w."currentBalanceMinor" <> 0;

INSERT INTO "LedgerPosting" (
  "id", "ledgerTransactionId", "accountId", "amountMinor", "createdAt"
)
SELECT
  md5('opening-wallet-posting:' || w."id"::text)::uuid,
  md5('opening-ledger-transaction:' || w."id"::text)::uuid,
  w."ledgerAccountId",
  w."currentBalanceMinor",
  CURRENT_TIMESTAMP
FROM "Wallet" w
WHERE w."currentBalanceMinor" <> 0;

INSERT INTO "LedgerPosting" (
  "id", "ledgerTransactionId", "accountId", "amountMinor", "createdAt"
)
SELECT
  md5('opening-clearing-posting:' || w."id"::text)::uuid,
  md5('opening-ledger-transaction:' || w."id"::text)::uuid,
  CASE w."currency"
    WHEN 'USD'::"Currency" THEN '00000000-0000-4000-8000-000000000001'::uuid
    WHEN 'NGN'::"Currency" THEN '00000000-0000-4000-8000-000000000002'::uuid
  END,
  -w."currentBalanceMinor",
  CURRENT_TIMESTAMP
FROM "Wallet" w
WHERE w."currentBalanceMinor" <> 0;

UPDATE "LedgerAccount" system_account
SET
  "balanceMinor" = -opening.total,
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT "currency", SUM("currentBalanceMinor") AS total
  FROM "Wallet"
  GROUP BY "currency"
) opening
WHERE system_account."kind" = 'SYSTEM'
  AND system_account."currency" = opening."currency";

-- Wallet identity and accounting linkage are permanent; wallet lifecycle uses status instead of deletion.
CREATE OR REPLACE FUNCTION "validateWalletLedgerAccount"()
RETURNS trigger AS $$
DECLARE
  account_kind "LedgerAccountKind";
  account_currency "Currency";
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."userId" <> OLD."userId"
    OR NEW."ledgerAccountId" <> OLD."ledgerAccountId"
    OR NEW."currency" <> OLD."currency"
  ) THEN
    RAISE EXCEPTION 'wallet owner, currency, and ledger account are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT "kind", "currency" INTO account_kind, account_currency
  FROM "LedgerAccount"
  WHERE "id" = NEW."ledgerAccountId";

  IF account_kind IS NULL OR account_kind <> 'WALLET' OR account_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'wallet ledger account must exist, be WALLET kind, and match currency'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Wallet_validate_ledger_account"
BEFORE INSERT OR UPDATE OF "userId", "ledgerAccountId", "currency" ON "Wallet"
FOR EACH ROW EXECUTE FUNCTION "validateWalletLedgerAccount"();

CREATE OR REPLACE FUNCTION "preventWalletDelete"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallets cannot be deleted; close them instead' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Wallet_prevent_delete"
BEFORE DELETE ON "Wallet"
FOR EACH ROW EXECUTE FUNCTION "preventWalletDelete"();

-- Account identity is immutable; only its balance snapshot and timestamp may change.
CREATE OR REPLACE FUNCTION "protectLedgerAccountIdentity"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts are immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."kind" <> OLD."kind"
    OR NEW."currency" <> OLD."currency"
    OR NEW."allowNegative" <> OLD."allowNegative"
    OR NEW."systemKey" IS DISTINCT FROM OLD."systemKey" THEN
    RAISE EXCEPTION 'ledger account identity fields are immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."balanceMinor" IS DISTINCT FROM OLD."balanceMinor"
    AND current_setting('app.ledger_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger account balances may only change through the ledger write path'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerAccount_protect_identity"
BEFORE UPDATE OR DELETE ON "LedgerAccount"
FOR EACH ROW EXECUTE FUNCTION "protectLedgerAccountIdentity"();

-- The public wallet balance is a derived read snapshot and may not be edited directly.
CREATE OR REPLACE FUNCTION "protectWalletBalance"()
RETURNS trigger AS $$
BEGIN
  IF NEW."currentBalanceMinor" IS DISTINCT FROM OLD."currentBalanceMinor"
    AND current_setting('app.ledger_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'wallet balances may only change through the ledger write path'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Wallet_protect_balance"
BEFORE UPDATE OF "currentBalanceMinor" ON "Wallet"
FOR EACH ROW EXECUTE FUNCTION "protectWalletBalance"();

-- Keep product-wallet snapshots synchronized from their canonical ledger account balance.
CREATE OR REPLACE FUNCTION "syncWalletBalanceFromLedgerAccount"()
RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'WALLET' AND NEW."balanceMinor" IS DISTINCT FROM OLD."balanceMinor" THEN
    UPDATE "Wallet"
    SET
      "currentBalanceMinor" = NEW."balanceMinor",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "ledgerAccountId" = NEW."id";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'wallet ledger account is missing its product wallet'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerAccount_sync_wallet_balance"
AFTER UPDATE OF "balanceMinor" ON "LedgerAccount"
FOR EACH ROW EXECUTE FUNCTION "syncWalletBalanceFromLedgerAccount"();

-- Ledger transactions start open, accept postings, then may be sealed exactly once.
CREATE OR REPLACE FUNCTION "protectLedgerTransaction"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sealedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'ledger transactions must be created unsealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger transactions are immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD."sealedAt" IS NULL
    AND NEW."sealedAt" IS NOT NULL
    AND NEW."id" = OLD."id"
    AND NEW."reference" = OLD."reference"
    AND NEW."currency" = OLD."currency"
    AND NEW."description" IS NOT DISTINCT FROM OLD."description"
    AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sealed ledger transactions are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerTransaction_protect"
BEFORE INSERT OR UPDATE OR DELETE ON "LedgerTransaction"
FOR EACH ROW EXECUTE FUNCTION "protectLedgerTransaction"();

-- Postings may only be inserted while their transaction is open and can never be edited/deleted.
CREATE OR REPLACE FUNCTION "protectLedgerPosting"()
RETURNS trigger AS $$
DECLARE
  transaction_sealed_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "sealedAt" INTO transaction_sealed_at
    FROM "LedgerTransaction"
    WHERE "id" = NEW."ledgerTransactionId";

    IF transaction_sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot add postings to a sealed ledger transaction' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ledger postings are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerPosting_protect"
BEFORE INSERT OR UPDATE OR DELETE ON "LedgerPosting"
FOR EACH ROW EXECUTE FUNCTION "protectLedgerPosting"();

-- At transaction commit, every ledger transaction must be sealed, balanced, and single-currency.
CREATE OR REPLACE FUNCTION "validateLedgerTransactionAtCommit"()
RETURNS trigger AS $$
DECLARE
  current_currency "Currency";
  current_sealed_at TIMESTAMPTZ;
  posting_count BIGINT;
  posting_total NUMERIC;
  mismatch_count BIGINT;
BEGIN
  SELECT "currency", "sealedAt" INTO current_currency, current_sealed_at
  FROM "LedgerTransaction"
  WHERE "id" = NEW."id";

  SELECT
    COUNT(*),
    COALESCE(SUM(p."amountMinor"), 0),
    COUNT(*) FILTER (WHERE a."currency" <> current_currency)
  INTO posting_count, posting_total, mismatch_count
  FROM "LedgerPosting" p
  JOIN "LedgerAccount" a ON a."id" = p."accountId"
  WHERE p."ledgerTransactionId" = NEW."id";

  IF current_sealed_at IS NULL THEN
    RAISE EXCEPTION 'ledger transaction must be sealed before commit' USING ERRCODE = '23514';
  END IF;

  IF posting_count < 2 THEN
    RAISE EXCEPTION 'ledger transaction requires at least two postings' USING ERRCODE = '23514';
  END IF;

  IF posting_total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction postings must sum to zero' USING ERRCODE = '23514';
  END IF;

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'ledger transaction and posting accounts must share one currency'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerTransaction_validate_at_commit"
AFTER INSERT OR UPDATE ON "LedgerTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateLedgerTransactionAtCommit"();
