-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookAttemptStatus" AS ENUM ('QUEUED', 'SENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(3),
    "leaseToken" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookAttempt" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "WebhookAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "httpStatus" INTEGER,
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookSubscription_userId_createdAt_idx" ON "WebhookSubscription"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_availableAt_createdAt_idx" ON "WebhookDelivery"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_id_idx" ON "WebhookDelivery"("subscriptionId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_subscriptionId_outboxEventId_key" ON "WebhookDelivery"("subscriptionId", "outboxEventId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookAttempt_deliveryId_number_key" ON "WebhookAttempt"("deliveryId", "number");

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookAttempt" ADD CONSTRAINT "WebhookAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_attemptCount_check"
  CHECK ("attemptCount" BETWEEN 0 AND 5);
ALTER TABLE "WebhookAttempt" ADD CONSTRAINT "WebhookAttempt_number_check"
  CHECK ("number" BETWEEN 1 AND 5);
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_lease_check"
  CHECK (("status" = 'PROCESSING' AND "leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL)
    OR ("status" <> 'PROCESSING' AND "leaseToken" IS NULL AND "leaseUntil" IS NULL));

-- Capture subscriptions visible to this INSERT's transaction snapshot. Later subscriptions
-- receive no historical events. The event, domain write and delivery rows commit together.
CREATE FUNCTION fan_out_webhook_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "WebhookDelivery" ("id", "subscriptionId", "outboxEventId")
  SELECT gen_random_uuid(), s."id", NEW."id"
  FROM "WebhookSubscription" s
  WHERE s."userId" = NEW."actorUserId" AND s."enabled"
  ON CONFLICT ("subscriptionId", "outboxEventId") DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OutboxEvent_webhook_fanout" AFTER INSERT ON "OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION fan_out_webhook_event();
