ALTER TYPE "PaymentProvider" ADD VALUE 'PAYSTACK';
CREATE TABLE "PaymentCheckout" (
 "paymentId" UUID NOT NULL PRIMARY KEY REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "checkoutUrl" VARCHAR(512),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PaymentCheckout_url_check" CHECK ("checkoutUrl" IS NULL OR "checkoutUrl" ~ '^https://checkout[.]paystack[.]com/[A-Za-z0-9_-]+$')
);

CREATE FUNCTION "protectPaymentCheckout"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment checkout claims cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."checkoutUrl" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "Payment" WHERE "id" = NEW."paymentId" AND "provider"::text = 'PAYSTACK'
    ) THEN
      RAISE EXCEPTION 'Checkout must start as an empty Paystack claim';
    END IF;
  ELSIF NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."checkoutUrl" IS NOT NULL OR NEW."checkoutUrl" IS NULL THEN
    RAISE EXCEPTION 'Checkout claims may only acquire their URL once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentCheckout_immutable_claim" BEFORE INSERT OR UPDATE OR DELETE
ON "PaymentCheckout" FOR EACH ROW EXECUTE FUNCTION "protectPaymentCheckout"();
