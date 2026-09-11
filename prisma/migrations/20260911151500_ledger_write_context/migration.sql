-- Ledger history may only be created or sealed inside the transaction-local ledger write path.
CREATE OR REPLACE FUNCTION "protectLedgerTransaction"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger transactions are immutable' USING ERRCODE = '23514';
  END IF;

  IF current_setting('app.ledger_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger transactions may only change through the ledger write path'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."sealedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'ledger transactions must be created unsealed' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
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

-- Postings can only be inserted by the ledger write path and remain immutable afterward.
CREATE OR REPLACE FUNCTION "protectLedgerPosting"()
RETURNS trigger AS $$
DECLARE
  transaction_sealed_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.ledger_write', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'ledger postings may only be created through the ledger write path'
        USING ERRCODE = '23514';
    END IF;

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
