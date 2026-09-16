-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboxEventType" ADD VALUE 'PAYMENT_SUCCEEDED';
ALTER TYPE "OutboxEventType" ADD VALUE 'PAYMENT_FAILED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_FAILED';

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "ledgerTransactionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventId" VARCHAR(128) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_ledgerTransactionId_key" ON "Payment"("ledgerTransactionId");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_id_idx" ON "Payment"("userId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_userId_idempotencyKey_key" ON "Payment"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProviderEvent_paymentId_createdAt_id_idx" ON "ProviderEvent"("paymentId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_provider_eventId_key" ON "ProviderEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderEvent" ADD CONSTRAINT "ProviderEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_key_check" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_state_check" CHECK (
  ("status" = 'PENDING' AND "ledgerTransactionId" IS NULL AND "completedAt" IS NULL)
  OR ("status" = 'SUCCEEDED' AND "ledgerTransactionId" IS NOT NULL AND "completedAt" IS NOT NULL)
  OR ("status" = 'FAILED' AND "ledgerTransactionId" IS NULL AND "completedAt" IS NOT NULL)
);
ALTER TABLE "ProviderEvent" ADD CONSTRAINT "ProviderEvent_hash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ProviderEvent" ADD CONSTRAINT "ProviderEvent_terminal_check" CHECK ("status" <> 'PENDING');

CREATE FUNCTION "protectPayment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment intents cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF current_setting('app.payment_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'payments require the payment write path' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'payments must begin pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'only pending payments may transition to a terminal state' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."userId", NEW."walletId", NEW."provider", NEW."reference", NEW."idempotencyKey", NEW."requestHash", NEW."amountMinor", NEW."currency", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."userId", OLD."walletId", OLD."provider", OLD."reference", OLD."idempotencyKey", OLD."requestHash", OLD."amountMinor", OLD."currency", OLD."createdAt") THEN
    RAISE EXCEPTION 'payment request identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Payment_protect" BEFORE INSERT OR UPDATE OR DELETE ON "Payment"
FOR EACH ROW EXECUTE FUNCTION "protectPayment"();

CREATE FUNCTION "protectProviderEvent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'provider event history is immutable' USING ERRCODE = '23514';
  END IF;
  IF current_setting('app.payment_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'provider events require the verified payment write path' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProviderEvent_protect" BEFORE INSERT OR UPDATE OR DELETE ON "ProviderEvent"
FOR EACH ROW EXECUTE FUNCTION "protectProviderEvent"();

CREATE FUNCTION "validatePaymentIntegrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p "Payment"%ROWTYPE;
  w "Wallet"%ROWTYPE;
  ledger "LedgerTransaction"%ROWTYPE;
  posting_count BIGINT;
  credit_count BIGINT;
  debit_count BIGINT;
BEGIN
  SELECT * INTO p FROM "Payment" WHERE "id" = NEW."id";
  SELECT * INTO w FROM "Wallet" WHERE "id" = p."walletId";
  IF w."id" IS NULL OR w."userId" <> p."userId" OR w."currency" <> p."currency" THEN
    RAISE EXCEPTION 'payment must target an owned wallet with matching currency' USING ERRCODE = '23514';
  END IF;
  IF p."status" = 'PENDING' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ProviderEvent" e WHERE e."paymentId" = p."id" AND e."provider" = p."provider" AND e."status" = p."status") THEN
    RAISE EXCEPTION 'settled payment requires matching provider evidence' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "OutboxEvent" e WHERE e."aggregateId" = p."id" AND e."aggregateType" = 'Payment'
    AND e."actorUserId" = p."userId" AND e."type"::text = CASE WHEN p."status" = 'SUCCEEDED' THEN 'PAYMENT_SUCCEEDED' ELSE 'PAYMENT_FAILED' END) THEN
    RAISE EXCEPTION 'settled payment requires its matching outbox event' USING ERRCODE = '23514';
  END IF;
  IF p."status" = 'FAILED' THEN RETURN NEW; END IF;
  SELECT * INTO ledger FROM "LedgerTransaction" WHERE "id" = p."ledgerTransactionId";
  IF ledger."id" IS NULL OR ledger."sealedAt" IS NULL OR ledger."currency" <> p."currency" OR ledger."reference" <> p."reference" THEN
    RAISE EXCEPTION 'successful payment requires a matching sealed ledger transaction' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE "accountId" = w."ledgerAccountId" AND "amountMinor" = p."amountMinor"),
    count(*) FILTER (WHERE "accountId" = (SELECT "id" FROM "LedgerAccount" WHERE "systemKey" = 'external-clearing:' || p."currency"::text) AND "amountMinor" = -p."amountMinor")
    INTO posting_count, credit_count, debit_count FROM "LedgerPosting" WHERE "ledgerTransactionId" = p."ledgerTransactionId";
  IF posting_count <> 2 OR credit_count <> 1 OR debit_count <> 1 THEN
    RAISE EXCEPTION 'payment requires exactly matching clearing debit and wallet credit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "Payment_integrity" AFTER INSERT OR UPDATE ON "Payment"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validatePaymentIntegrity"();

CREATE FUNCTION "validateProviderEventIntegrity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."id" = NEW."paymentId" AND p."provider" = NEW."provider" AND p."status" = NEW."status") THEN
    RAISE EXCEPTION 'provider evidence must match its settled payment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ProviderEvent_integrity" AFTER INSERT ON "ProviderEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validateProviderEventIntegrity"();
