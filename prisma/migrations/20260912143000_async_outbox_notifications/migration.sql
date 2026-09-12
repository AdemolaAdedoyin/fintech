CREATE TYPE "OutboxEventType" AS ENUM ('TRANSFER_COMPLETED', 'TRANSFER_REVERSED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED');
CREATE TYPE "NotificationType" AS ENUM ('TRANSFER_COMPLETED', 'TRANSFER_REVERSED');

CREATE TABLE "OutboxEvent" (
  "id" UUID NOT NULL,
  "type" "OutboxEventType" NOT NULL,
  "aggregateType" VARCHAR(64) NOT NULL,
  "aggregateId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "publishedAt" TIMESTAMPTZ(3),
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "OutboxEvent_state_check" CHECK (
    ("status" = 'PENDING' AND "lockedAt" IS NULL AND "publishedAt" IS NULL)
    OR ("status" = 'PROCESSING' AND "lockedAt" IS NOT NULL AND "publishedAt" IS NULL)
    OR ("status" = 'PUBLISHED' AND "lockedAt" IS NULL AND "publishedAt" IS NOT NULL)
  )
);

CREATE TABLE "Notification" (
  "id" UUID NOT NULL,
  "outboxEventId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "type" "NotificationType" NOT NULL,
  "subject" VARCHAR(160) NOT NULL,
  "body" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutboxEvent_status_availableAt_createdAt_idx" ON "OutboxEvent"("status", "availableAt", "createdAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");
CREATE UNIQUE INDEX "OutboxEvent_type_aggregateId_key" ON "OutboxEvent"("type", "aggregateId");
CREATE UNIQUE INDEX "Notification_outboxEventId_key" ON "Notification"("outboxEventId");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
