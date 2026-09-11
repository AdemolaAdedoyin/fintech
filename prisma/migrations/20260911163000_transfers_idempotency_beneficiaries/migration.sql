-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Beneficiary_label_check" CHECK (char_length(btrim("label")) BETWEEN 1 AND 80 AND "label" = btrim("label"))
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "senderUserId" UUID NOT NULL,
    "sourceWalletId" UUID NOT NULL,
    "destinationWalletId" UUID NOT NULL,
    "beneficiaryId" UUID,
    "ledgerTransactionId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Transfer_positive_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "Transfer_distinct_wallets_check" CHECK ("sourceWalletId" <> "destinationWalletId"),
    CONSTRAINT "Transfer_completion_check" CHECK (
      ("status" = 'PENDING' AND "completedAt" IS NULL)
      OR ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "errorMessage" VARCHAR(255),
    "transferId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyRecord_scope_check" CHECK (
      char_length(btrim("scope")) BETWEEN 1 AND 64 AND "scope" = btrim("scope")
    ),
    CONSTRAINT "IdempotencyRecord_key_check" CHECK (
      char_length(btrim("key")) BETWEEN 1 AND 128 AND "key" = btrim("key")
    ),
    CONSTRAINT "IdempotencyRecord_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_terminal_state_check" CHECK (
      ("status" = 'IN_PROGRESS' AND "transferId" IS NULL AND "responseStatus" IS NULL AND "errorMessage" IS NULL)
      OR ("status" = 'COMPLETED' AND "transferId" IS NOT NULL AND "responseStatus" BETWEEN 200 AND 299 AND "errorMessage" IS NULL)
      OR ("status" = 'FAILED' AND "transferId" IS NULL AND "responseStatus" BETWEEN 400 AND 499 AND "errorMessage" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_ownerUserId_walletId_key" ON "Beneficiary"("ownerUserId", "walletId");
CREATE INDEX "Beneficiary_ownerUserId_createdAt_idx" ON "Beneficiary"("ownerUserId", "createdAt");

CREATE UNIQUE INDEX "Transfer_reference_key" ON "Transfer"("reference");
CREATE UNIQUE INDEX "Transfer_ledgerTransactionId_key" ON "Transfer"("ledgerTransactionId");
CREATE INDEX "Transfer_senderUserId_createdAt_idx" ON "Transfer"("senderUserId", "createdAt");
CREATE INDEX "Transfer_sourceWalletId_createdAt_idx" ON "Transfer"("sourceWalletId", "createdAt");
CREATE INDEX "Transfer_destinationWalletId_createdAt_idx" ON "Transfer"("destinationWalletId", "createdAt");

CREATE UNIQUE INDEX "IdempotencyRecord_transferId_key" ON "IdempotencyRecord"("transferId");
CREATE UNIQUE INDEX "IdempotencyRecord_userId_scope_key_key" ON "IdempotencyRecord"("userId", "scope", "key");
CREATE INDEX "IdempotencyRecord_userId_createdAt_idx" ON "IdempotencyRecord"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderUserId_fkey"
  FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_sourceWalletId_fkey"
  FOREIGN KEY ("sourceWalletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_destinationWalletId_fkey"
  FOREIGN KEY ("destinationWalletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_beneficiaryId_fkey"
  FOREIGN KEY ("beneficiaryId") REFERENCES "Beneficiary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_ledgerTransactionId_fkey"
  FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Transfer rows are application-owned records and may only be created through the transfer write path.
CREATE FUNCTION "protectTransfer"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completed transfers cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.transfer_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'transfers may only change through the transfer write path'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed transfers are immutable' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Transfer_protect_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "Transfer"
FOR EACH ROW EXECUTE FUNCTION "protectTransfer"();

-- A committed transfer must describe exactly the sealed two-posting ledger transaction that moved the money.
CREATE FUNCTION "validateTransferIntegrity"()
RETURNS trigger AS $$
DECLARE
  source_owner UUID;
  source_currency "Currency";
  destination_currency "Currency";
  ledger_currency "Currency";
  ledger_reference VARCHAR(120);
  ledger_sealed_at TIMESTAMPTZ;
  posting_count BIGINT;
  source_debit_count BIGINT;
  destination_credit_count BIGINT;
  beneficiary_owner UUID;
  beneficiary_wallet UUID;
BEGIN
  IF NEW."status" <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  SELECT "userId", "currency"
    INTO source_owner, source_currency
  FROM "Wallet"
  WHERE "id" = NEW."sourceWalletId";

  SELECT "currency"
    INTO destination_currency
  FROM "Wallet"
  WHERE "id" = NEW."destinationWalletId";

  IF source_owner IS NULL OR source_owner <> NEW."senderUserId" THEN
    RAISE EXCEPTION 'transfer source wallet must belong to the sender' USING ERRCODE = '23514';
  END IF;

  IF source_currency <> NEW."currency" OR destination_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'transfer wallets must match the transfer currency' USING ERRCODE = '23514';
  END IF;

  IF NEW."beneficiaryId" IS NOT NULL THEN
    SELECT "ownerUserId", "walletId"
      INTO beneficiary_owner, beneficiary_wallet
    FROM "Beneficiary"
    WHERE "id" = NEW."beneficiaryId";

    IF beneficiary_owner IS NULL
      OR beneficiary_owner <> NEW."senderUserId"
      OR beneficiary_wallet <> NEW."destinationWalletId" THEN
      RAISE EXCEPTION 'transfer beneficiary must belong to the sender and target the destination wallet'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT "currency", "reference", "sealedAt"
    INTO ledger_currency, ledger_reference, ledger_sealed_at
  FROM "LedgerTransaction"
  WHERE "id" = NEW."ledgerTransactionId";

  IF ledger_sealed_at IS NULL
    OR ledger_currency <> NEW."currency"
    OR ledger_reference <> NEW."reference" THEN
    RAISE EXCEPTION 'transfer must reference a matching sealed ledger transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE "accountId" = (SELECT "ledgerAccountId" FROM "Wallet" WHERE "id" = NEW."sourceWalletId")
        AND "amountMinor" = -NEW."amountMinor"
    ),
    count(*) FILTER (
      WHERE "accountId" = (SELECT "ledgerAccountId" FROM "Wallet" WHERE "id" = NEW."destinationWalletId")
        AND "amountMinor" = NEW."amountMinor"
    )
    INTO posting_count, source_debit_count, destination_credit_count
  FROM "LedgerPosting"
  WHERE "ledgerTransactionId" = NEW."ledgerTransactionId";

  IF posting_count <> 2 OR source_debit_count <> 1 OR destination_credit_count <> 1 THEN
    RAISE EXCEPTION 'transfer ledger transaction must contain exactly the matching debit and credit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Transfer_integrity_check"
AFTER INSERT OR UPDATE ON "Transfer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateTransferIntegrity"();

-- Completed idempotency records must point to a transfer initiated by the same user.
CREATE FUNCTION "validateIdempotencyIntegrity"()
RETURNS trigger AS $$
DECLARE
  transfer_sender UUID;
BEGIN
  IF NEW."status" = 'COMPLETED' THEN
    SELECT "senderUserId" INTO transfer_sender
    FROM "Transfer"
    WHERE "id" = NEW."transferId";

    IF transfer_sender IS NULL OR transfer_sender <> NEW."userId" THEN
      RAISE EXCEPTION 'completed idempotency record must reference a transfer owned by the same user'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "IdempotencyRecord_integrity_check"
AFTER INSERT OR UPDATE ON "IdempotencyRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateIdempotencyIntegrity"();
