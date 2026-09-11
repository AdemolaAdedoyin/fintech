-- Idempotency claims begin in-progress and terminal outcomes are immutable.
CREATE FUNCTION "protectIdempotencyRecord"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'IN_PROGRESS'
      OR NEW."responseStatus" IS NOT NULL
      OR NEW."errorMessage" IS NOT NULL
      OR NEW."transferId" IS NOT NULL THEN
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

CREATE TRIGGER "IdempotencyRecord_protect_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "IdempotencyRecord"
FOR EACH ROW EXECUTE FUNCTION "protectIdempotencyRecord"();
