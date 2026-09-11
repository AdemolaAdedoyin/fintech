-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('TRANSFER_CREATED', 'TRANSFER_REVERSED');

-- CreateTable
CREATE TABLE "TransferReversal" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "transferId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "ledgerTransactionId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reason" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferReversal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TransferReversal_positive_amount_check" CHECK ("amountMinor" > 0),
    CONSTRAINT "TransferReversal_reason_check" CHECK (
      "reason" IS NULL
      OR (char_length(btrim("reason")) BETWEEN 1 AND 255 AND "reason" = btrim("reason"))
    )
);

-- Extend persistent idempotency so a completed claim can point to a reversal.
ALTER TABLE "IdempotencyRecord" ADD COLUMN "reversalId" UUID;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "transferId" UUID NOT NULL,
    "reversalId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditLog_action_shape_check" CHECK (
      ("action" = 'TRANSFER_CREATED' AND "reversalId" IS NULL)
      OR ("action" = 'TRANSFER_REVERSED' AND "reversalId" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "TransferReversal_reference_key" ON "TransferReversal"("reference");
CREATE UNIQUE INDEX "TransferReversal_transferId_key" ON "TransferReversal"("transferId");
CREATE UNIQUE INDEX "TransferReversal_ledgerTransactionId_key" ON "TransferReversal"("ledgerTransactionId");
CREATE INDEX "TransferReversal_actorUserId_createdAt_idx" ON "TransferReversal"("actorUserId", "createdAt");

CREATE UNIQUE INDEX "IdempotencyRecord_reversalId_key" ON "IdempotencyRecord"("reversalId");

CREATE UNIQUE INDEX "AuditLog_reversalId_key" ON "AuditLog"("reversalId");
CREATE UNIQUE INDEX "AuditLog_action_transferId_key" ON "AuditLog"("action", "transferId");
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "TransferReversal" ADD CONSTRAINT "TransferReversal_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransferReversal" ADD CONSTRAINT "TransferReversal_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransferReversal" ADD CONSTRAINT "TransferReversal_ledgerTransactionId_fkey"
  FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_reversalId_fkey"
  FOREIGN KEY ("reversalId") REFERENCES "TransferReversal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_reversalId_fkey"
  FOREIGN KEY ("reversalId") REFERENCES "TransferReversal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A completed idempotency record now points to exactly one supported resource.
ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "IdempotencyRecord_terminal_state_check";
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_terminal_state_check" CHECK (
  ("status" = 'IN_PROGRESS'
    AND "transferId" IS NULL
    AND "reversalId" IS NULL
    AND "responseStatus" IS NULL
    AND "errorMessage" IS NULL)
  OR ("status" = 'COMPLETED'
    AND num_nonnulls("transferId", "reversalId") = 1
    AND "responseStatus" BETWEEN 200 AND 299
    AND "errorMessage" IS NULL)
  OR ("status" = 'FAILED'
    AND "transferId" IS NULL
    AND "reversalId" IS NULL
    AND "responseStatus" BETWEEN 400 AND 499
    AND "errorMessage" IS NOT NULL)
);

CREATE OR REPLACE FUNCTION "protectIdempotencyRecord"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'IN_PROGRESS'
      OR NEW."responseStatus" IS NOT NULL
      OR NEW."errorMessage" IS NOT NULL
      OR NEW."transferId" IS NOT NULL
      OR NEW."reversalId" IS NOT NULL THEN
      RAISE EXCEPTION 'new idempotency records must begin in progress'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('COMPLETED', 'FAILED') THEN
      RAISE EXCEPTION 'terminal idempotency records are immutable'
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD."status" IN ('COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'terminal idempotency records are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'idempotency request identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" NOT IN ('COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'idempotency records may only transition from in progress to a terminal state'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validateIdempotencyIntegrity"()
RETURNS trigger AS $$
DECLARE
  resource_owner UUID;
BEGIN
  IF NEW."status" <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NEW."transferId" IS NOT NULL THEN
    IF NEW."scope" <> 'internal-transfer' THEN
      RAISE EXCEPTION 'transfer idempotency record has the wrong scope'
        USING ERRCODE = '23514';
    END IF;

    SELECT "senderUserId" INTO resource_owner
    FROM "Transfer"
    WHERE "id" = NEW."transferId";
  ELSE
    IF NEW."scope" <> 'transfer-reversal' THEN
      RAISE EXCEPTION 'reversal idempotency record has the wrong scope'
        USING ERRCODE = '23514';
    END IF;

    SELECT "actorUserId" INTO resource_owner
    FROM "TransferReversal"
    WHERE "id" = NEW."reversalId";
  END IF;

  IF resource_owner IS NULL OR resource_owner <> NEW."userId" THEN
    RAISE EXCEPTION 'completed idempotency record must reference a resource owned by the same user'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Reversals are immutable compensating accounting events and may only be created through the reversal path.
CREATE FUNCTION "protectTransferReversal"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'transfer reversals are immutable' USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.reversal_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'transfer reversals may only be created through the reversal write path'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TransferReversal_protect_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "TransferReversal"
FOR EACH ROW EXECUTE FUNCTION "protectTransferReversal"();

-- A committed reversal must be the exact compensating ledger transaction for its original transfer.
CREATE FUNCTION "validateTransferReversalIntegrity"()
RETURNS trigger AS $$
DECLARE
  transfer_sender UUID;
  source_account UUID;
  destination_account UUID;
  transfer_currency "Currency";
  transfer_amount BIGINT;
  transfer_status "TransferStatus";
  ledger_currency "Currency";
  ledger_reference VARCHAR(120);
  ledger_sealed_at TIMESTAMPTZ;
  posting_count BIGINT;
  source_credit_count BIGINT;
  destination_debit_count BIGINT;
  audit_count BIGINT;
BEGIN
  SELECT
    t."senderUserId",
    source_wallet."ledgerAccountId",
    destination_wallet."ledgerAccountId",
    t."currency",
    t."amountMinor",
    t."status"
  INTO
    transfer_sender,
    source_account,
    destination_account,
    transfer_currency,
    transfer_amount,
    transfer_status
  FROM "Transfer" t
  JOIN "Wallet" source_wallet ON source_wallet."id" = t."sourceWalletId"
  JOIN "Wallet" destination_wallet ON destination_wallet."id" = t."destinationWalletId"
  WHERE t."id" = NEW."transferId";

  IF transfer_sender IS NULL OR transfer_sender <> NEW."actorUserId" THEN
    RAISE EXCEPTION 'only the original transfer sender may own a reversal'
      USING ERRCODE = '23514';
  END IF;

  IF transfer_status <> 'COMPLETED'
    OR transfer_currency <> NEW."currency"
    OR transfer_amount <> NEW."amountMinor" THEN
    RAISE EXCEPTION 'reversal must exactly match a completed original transfer'
      USING ERRCODE = '23514';
  END IF;

  SELECT "currency", "reference", "sealedAt"
    INTO ledger_currency, ledger_reference, ledger_sealed_at
  FROM "LedgerTransaction"
  WHERE "id" = NEW."ledgerTransactionId";

  IF ledger_sealed_at IS NULL
    OR ledger_currency <> NEW."currency"
    OR ledger_reference <> NEW."reference" THEN
    RAISE EXCEPTION 'reversal must reference a matching sealed ledger transaction'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE "accountId" = source_account
        AND "amountMinor" = NEW."amountMinor"
    ),
    count(*) FILTER (
      WHERE "accountId" = destination_account
        AND "amountMinor" = -NEW."amountMinor"
    )
  INTO posting_count, source_credit_count, destination_debit_count
  FROM "LedgerPosting"
  WHERE "ledgerTransactionId" = NEW."ledgerTransactionId";

  IF posting_count <> 2 OR source_credit_count <> 1 OR destination_debit_count <> 1 THEN
    RAISE EXCEPTION 'reversal ledger transaction must exactly compensate the original transfer'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO audit_count
  FROM "AuditLog"
  WHERE "reversalId" = NEW."id"
    AND "transferId" = NEW."transferId"
    AND "actorUserId" = NEW."actorUserId"
    AND "action" = 'TRANSFER_REVERSED';

  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'reversal must create exactly one matching audit event'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "TransferReversal_integrity_check"
AFTER INSERT ON "TransferReversal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateTransferReversalIntegrity"();

-- Audit history is append-only and only accepted through guarded application write paths.
CREATE FUNCTION "protectAuditLog"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'audit records are immutable' USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.audit_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'audit records may only be created through the audit write path'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_protect_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "protectAuditLog"();

CREATE FUNCTION "validateAuditLogIntegrity"()
RETURNS trigger AS $$
DECLARE
  transfer_sender UUID;
  reversal_transfer UUID;
  reversal_actor UUID;
BEGIN
  SELECT "senderUserId" INTO transfer_sender
  FROM "Transfer"
  WHERE "id" = NEW."transferId";

  IF transfer_sender IS NULL OR transfer_sender <> NEW."actorUserId" THEN
    RAISE EXCEPTION 'audit actor must own the transfer event'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."action" = 'TRANSFER_REVERSED' THEN
    SELECT "transferId", "actorUserId"
      INTO reversal_transfer, reversal_actor
    FROM "TransferReversal"
    WHERE "id" = NEW."reversalId";

    IF reversal_transfer IS NULL
      OR reversal_transfer <> NEW."transferId"
      OR reversal_actor <> NEW."actorUserId" THEN
      RAISE EXCEPTION 'reversal audit event must reference the matching reversal'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AuditLog_integrity_check"
AFTER INSERT ON "AuditLog"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateAuditLogIntegrity"();
