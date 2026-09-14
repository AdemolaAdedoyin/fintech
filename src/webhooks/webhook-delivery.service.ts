import { Injectable } from '@nestjs/common';
import { Prisma, type WebhookDelivery } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookTransportError, WebhookTransportService } from './webhook-transport.service';

export interface WebhookJobData {
  deliveryId: string;
  leaseToken: string;
}
interface Outcome {
  httpStatus?: number;
  errorCode?: string;
  retry: boolean;
  success: boolean;
}
const maxAttempts = 5;

@Injectable()
export class WebhookDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: WebhookCryptoService,
    private readonly transport: WebhookTransportService,
  ) {}

  async claimBatch(): Promise<WebhookJobData[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<WebhookDelivery[]>(Prisma.sql`
        SELECT * FROM "WebhookDelivery"
        WHERE ("status" = 'PENDING' AND "availableAt" <= clock_timestamp())
           OR ("status" = 'PROCESSING' AND "leaseUntil" <= clock_timestamp())
        ORDER BY "createdAt", "id" LIMIT 10 FOR UPDATE SKIP LOCKED
      `);
      const jobs: WebhookJobData[] = [];
      for (const row of rows) {
        await tx.webhookAttempt.updateMany({
          where: { deliveryId: row.id, status: { in: ['QUEUED', 'SENDING'] } },
          data: { status: 'ABANDONED', completedAt: new Date(), errorCode: 'LEASE_EXPIRED' },
        });
        const subscription = await tx.webhookSubscription.findUniqueOrThrow({
          where: { id: row.subscriptionId },
        });
        if (!subscription.enabled || row.attemptCount >= maxAttempts) {
          await tx.webhookDelivery.update({
            where: { id: row.id },
            data: {
              status: subscription.enabled ? 'FAILED' : 'CANCELLED',
              leaseToken: null,
              leaseUntil: null,
            },
          });
          continue;
        }
        const leaseToken = randomUUID();
        await tx.$executeRaw(Prisma.sql`
          UPDATE "WebhookDelivery" SET "status" = 'PROCESSING', "attemptCount" = "attemptCount" + 1,
            "leaseToken" = ${leaseToken}::uuid, "leaseUntil" = clock_timestamp() + INTERVAL '30 seconds'
          WHERE "id" = ${row.id}::uuid
        `);
        await tx.webhookAttempt.create({
          data: { deliveryId: row.id, number: row.attemptCount + 1 },
        });
        jobs.push({ deliveryId: row.id, leaseToken });
      }
      return jobs;
    });
  }

  private async locked(
    tx: Prisma.TransactionClient,
    job: WebhookJobData,
  ): Promise<WebhookDelivery | undefined> {
    const rows = await tx.$queryRaw<WebhookDelivery[]>(Prisma.sql`
      SELECT * FROM "WebhookDelivery" WHERE "id" = ${job.deliveryId}::uuid
        AND "status" = 'PROCESSING' AND "leaseToken" = ${job.leaseToken}::uuid
        AND "leaseUntil" > clock_timestamp() FOR UPDATE
    `);
    return rows[0];
  }

  private async start(job: WebhookJobData) {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.locked(tx, job);
      if (!row) return null;
      const subscription = await tx.webhookSubscription.findUniqueOrThrow({
        where: { id: row.subscriptionId },
      });
      if (!subscription.enabled) {
        await tx.webhookDelivery.update({
          where: { id: row.id },
          data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
        });
        await tx.webhookAttempt.updateMany({
          where: { deliveryId: row.id, number: row.attemptCount, status: 'QUEUED' },
          data: { status: 'CANCELLED', completedAt: new Date() },
        });
        return null;
      }
      const changed = await tx.webhookAttempt.updateMany({
        where: { deliveryId: row.id, number: row.attemptCount, status: 'QUEUED' },
        data: { status: 'SENDING' },
      });
      if (!changed.count) return null;
      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: row.outboxEventId } });
      return { row, subscription, event };
    });
  }

  async execute(job: WebhookJobData): Promise<void> {
    const delivery = await this.start(job);
    if (!delivery) return;
    let outcome: Outcome;
    let secret: string;
    try {
      secret = this.crypto.decrypt(delivery.subscription.encryptedSecret);
    } catch {
      await this.finish(
        job,
        { retry: false, success: false, errorCode: 'SIGNING_UNAVAILABLE' },
        'SENDING',
      );
      return;
    }
    const body = JSON.stringify({
      id: delivery.event.id,
      deliveryId: delivery.row.id,
      type: delivery.event.type,
      createdAt: delivery.event.createdAt.toISOString(),
      data: delivery.event.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const httpStatus = await this.transport.send(delivery.subscription.url, body, {
        'Webhook-Id': delivery.row.id,
        'Webhook-Event-Id': delivery.event.id,
        'Webhook-Timestamp': timestamp,
        'Webhook-Signature': this.crypto.sign(secret, timestamp, body),
      });
      outcome = {
        httpStatus,
        success: httpStatus >= 200 && httpStatus < 300,
        retry: httpStatus === 408 || httpStatus === 429 || httpStatus >= 500,
      };
    } catch (error) {
      const errorCode = error instanceof WebhookTransportError ? error.code : 'NETWORK_ERROR';
      outcome = { success: false, retry: errorCode !== 'UNSAFE_ENDPOINT', errorCode };
    }
    // Persistence failures propagate. Never reinterpret a DB error after HTTP success as an HTTP failure.
    // Lease expiry recovers the unknown result; recipients must deduplicate the stable delivery ID.
    await this.finish(job, outcome, 'SENDING');
  }

  async publicationFailed(job: WebhookJobData): Promise<void> {
    // An ambiguous enqueue may already be executing. Only a still-QUEUED attempt can be released.
    await this.finish(
      job,
      { success: false, retry: true, errorCode: 'QUEUE_UNAVAILABLE' },
      'QUEUED',
    );
  }

  private async finish(
    job: WebhookJobData,
    outcome: Outcome,
    expected: 'QUEUED' | 'SENDING',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.locked(tx, job);
      if (!row) return;
      const subscription = await tx.webhookSubscription.findUniqueOrThrow({
        where: { id: row.subscriptionId },
      });
      const cancelled = !subscription.enabled;
      const retry = !cancelled && outcome.retry && row.attemptCount < maxAttempts;
      const changed = await tx.webhookAttempt.updateMany({
        where: { deliveryId: row.id, number: row.attemptCount, status: expected },
        data: {
          status: cancelled ? 'CANCELLED' : outcome.success ? 'SUCCEEDED' : 'FAILED',
          httpStatus: outcome.httpStatus,
          errorCode: outcome.errorCode,
          completedAt: new Date(),
        },
      });
      if (!changed.count) return;
      await tx.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: cancelled
            ? 'CANCELLED'
            : outcome.success
              ? 'DELIVERED'
              : retry
                ? 'PENDING'
                : 'FAILED',
          leaseToken: null,
          leaseUntil: null,
          ...(retry
            ? { availableAt: new Date(Date.now() + 1000 * 2 ** (row.attemptCount - 1)) }
            : {}),
        },
      });
    });
  }
}
