-- New ledger accounts must start at zero; money only enters through postings.
CREATE OR REPLACE FUNCTION "protectLedgerAccountIdentity"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balanceMinor" <> 0 THEN
      RAISE EXCEPTION 'new ledger accounts must start with a zero balance'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

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

DROP TRIGGER "LedgerAccount_protect_identity" ON "LedgerAccount";
CREATE TRIGGER "LedgerAccount_protect_identity"
BEFORE INSERT OR UPDATE OR DELETE ON "LedgerAccount"
FOR EACH ROW EXECUTE FUNCTION "protectLedgerAccountIdentity"();

-- A new product wallet must begin synchronized with its ledger account.
CREATE OR REPLACE FUNCTION "validateWalletLedgerAccount"()
RETURNS trigger AS $$
DECLARE
  account_kind "LedgerAccountKind";
  account_currency "Currency";
  account_balance BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."userId" <> OLD."userId"
    OR NEW."ledgerAccountId" <> OLD."ledgerAccountId"
    OR NEW."currency" <> OLD."currency"
  ) THEN
    RAISE EXCEPTION 'wallet owner, currency, and ledger account are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT "kind", "currency", "balanceMinor"
  INTO account_kind, account_currency, account_balance
  FROM "LedgerAccount"
  WHERE "id" = NEW."ledgerAccountId";

  IF account_kind IS NULL OR account_kind <> 'WALLET' OR account_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'wallet ledger account must exist, be WALLET kind, and match currency'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."currentBalanceMinor" <> account_balance THEN
    RAISE EXCEPTION 'new wallet balance must match its ledger account balance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every wallet-kind account must have exactly one product wallet by commit; system accounts must have none.
CREATE OR REPLACE FUNCTION "validateLedgerAccountPairAtCommit"()
RETURNS trigger AS $$
DECLARE
  linked_wallet_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO linked_wallet_count
  FROM "Wallet"
  WHERE "ledgerAccountId" = NEW."id";

  IF NEW."kind" = 'WALLET' AND linked_wallet_count <> 1 THEN
    RAISE EXCEPTION 'wallet ledger account must be linked to exactly one product wallet'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'SYSTEM' AND linked_wallet_count <> 0 THEN
    RAISE EXCEPTION 'system ledger accounts cannot be linked to product wallets'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerAccount_validate_pair_at_commit"
AFTER INSERT ON "LedgerAccount"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateLedgerAccountPairAtCommit"();

-- Sealing is a forward-only lifecycle event.
ALTER TABLE "LedgerTransaction"
ADD CONSTRAINT "LedgerTransaction_sealed_time_check"
CHECK ("sealedAt" IS NULL OR "sealedAt" >= "createdAt");
