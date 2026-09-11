-- CreateEnum
CREATE TYPE "OutboxEventType" AS ENUM ('TRANSFER_COMPLETED', 'TRANSFER_REVERSED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "eventType" "OutboxEventType" NOT NULL,
    "transferId" UUID,
    "reversalId" UUID,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextPublishAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OutboxEvent_source_shape_check" CHECK (
      ("eventType" = 'TRANSFER_COMPLETED' AND "transferId" IS NOT NULL AND "reversalId" IS NULL)
      OR
      ("eventType" = 'TRANSFER_REVERSED' AND "transferId" IS NULL AND "reversalId" IS NOT NULL)
    ),
    CONSTRAINT "OutboxEvent_attempts_check" CHECK ("publishAttempts" >= 0)
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "eventType" "OutboxEventType" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Notification_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "Notification_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 255)
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "description" VARCHAR(120),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookEndpoint_https_check" CHECK ("url" LIKE 'https://%'),
    CONSTRAINT "WebhookEndpoint_description_check" CHECK (
      "description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 120
    )
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "responseStatus" INTEGER,
    "lastError" VARCHAR(500),
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookDelivery_attempts_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "WebhookDelivery_response_status_check" CHECK (
      "responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599
    ),
    CONSTRAINT "WebhookDelivery_success_shape_check" CHECK (
      ("status" = 'SUCCEEDED' AND "deliveredAt" IS NOT NULL)
      OR ("status" <> 'SUCCEEDED' AND "deliveredAt" IS NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_transferId_key" ON "OutboxEvent"("transferId");
CREATE UNIQUE INDEX "OutboxEvent_reversalId_key" ON "OutboxEvent"("reversalId");
CREATE INDEX "OutboxEvent_publishedAt_nextPublishAt_createdAt_idx"
  ON "OutboxEvent"("publishedAt", "nextPublishAt", "createdAt");

CREATE UNIQUE INDEX "Notification_userId_outboxEventId_key"
  ON "Notification"("userId", "outboxEventId");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

CREATE INDEX "WebhookEndpoint_userId_createdAt_idx"
  ON "WebhookEndpoint"("userId", "createdAt");

CREATE UNIQUE INDEX "WebhookDelivery_endpointId_outboxEventId_key"
  ON "WebhookDelivery"("endpointId", "outboxEventId");
CREATE INDEX "WebhookDelivery_status_queuedAt_createdAt_idx"
  ON "WebhookDelivery"("status", "queuedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_reversalId_fkey"
  FOREIGN KEY ("reversalId") REFERENCES "TransferReversal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Outbox event identity and payload are immutable once committed. Dispatcher metadata may advance.
CREATE FUNCTION "protectOutboxEvent"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.outbox_write', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'outbox events may only be created through the transactional outbox path'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
    OR NEW."transferId" IS DISTINCT FROM OLD."transferId"
    OR NEW."reversalId" IS DISTINCT FROM OLD."reversalId"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'outbox event identity and payload are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."publishAttempts" < OLD."publishAttempts" THEN
    RAISE EXCEPTION 'outbox publish attempt count cannot decrease'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'published outbox timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutboxEvent_protect_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "OutboxEvent"
FOR EACH ROW EXECUTE FUNCTION "protectOutboxEvent"();

-- Notification event identity is immutable; only readAt may change after creation.
CREATE FUNCTION "protectNotification"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notifications cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."userId" IS DISTINCT FROM OLD."userId"
      OR NEW."outboxEventId" IS DISTINCT FROM OLD."outboxEventId"
      OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
      OR NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."body" IS DISTINCT FROM OLD."body"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'notification event data is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD."readAt" IS NOT NULL AND NEW."readAt" IS DISTINCT FROM OLD."readAt" THEN
      RAISE EXCEPTION 'notification read timestamp is immutable once set'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Notification_protect_trigger"
BEFORE UPDATE OR DELETE ON "Notification"
FOR EACH ROW EXECUTE FUNCTION "protectNotification"();
