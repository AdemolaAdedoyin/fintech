import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventType, Prisma, WebhookDeliveryStatus, type OutboxEvent } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOMAIN_EVENTS_QUEUE,
  OUTBOX_DISPATCH_INTERVAL_MS,
  WEBHOOK_DELIVERY_QUEUE,
  WEBHOOK_DISPATCH_INTERVAL_MS,
  WEBHOOK_PROCESSING_STALE_MS,
} from './queue.constants';
import { WebhookSigningService } from './webhook-signing.service';

interface DomainEventPayload {
  senderUserId: string;
  recipientUserId: string;
  transferId: string;
  reference: string;
  amountMinor: string;
  currency: string;
  reversalId?: string;
}

@Injectable()
export class AsyncRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsyncRuntimeService.name);
  private readonly connection: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db: number;
    tls?: { servername: string };
    maxRetriesPerRequest: null;
  };
  private readonly domainQueue: Queue;
  private readonly webhookQueue: Queue;
  private domainWorker?: Worker;
  private webhookWorker?: Worker;
  private outboxTimer?: NodeJS.Timeout;
  private webhookTimer?: NodeJS.Timeout;
  private dispatchingOutbox = false;
  private dispatchingWebhooks = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
  ) {
    this.connection = this.parseRedisConnection(this.config.getOrThrow<string>('REDIS_URL'));
    this.domainQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: this.connection });
    this.webhookQueue = new Queue(WEBHOOK_DELIVERY_QUEUE, { connection: this.connection });

    this.domainQueue.on('error', (error) => {
      this.logger.warn(`Domain queue Redis error: ${error.message}`);
    });
    this.webhookQueue.on('error', (error) => {
      this.logger.warn(`Webhook queue Redis error: ${error.message}`);
    });
  }

  onModuleInit(): void {
    this.domainWorker = new Worker(
      DOMAIN_EVENTS_QUEUE,
      async (job) => this.processDomainEvent(job),
      { connection: this.connection, concurrency: 8 },
    );
    this.webhookWorker = new Worker(
      WEBHOOK_DELIVERY_QUEUE,
      async (job) => this.processWebhookDelivery(job),
      { connection: this.connection, concurrency: 4 },
    );

    this.domainWorker.on('error', (error) => {
      this.logger.warn(`Domain worker Redis error: ${error.message}`);
    });
    this.webhookWorker.on('error', (error) => {
      this.logger.warn(`Webhook worker Redis error: ${error.message}`);
    });

    this.outboxTimer = setInterval(() => void this.dispatchOutbox(), OUTBOX_DISPATCH_INTERVAL_MS);
    this.webhookTimer = setInterval(
      () => void this.dispatchWebhookDeliveries(),
      WEBHOOK_DISPATCH_INTERVAL_MS,
    );
    this.outboxTimer.unref();
    this.webhookTimer.unref();

    void this.dispatchOutbox();
    void this.dispatchWebhookDeliveries();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.webhookTimer) clearInterval(this.webhookTimer);

    await Promise.allSettled([
      this.domainWorker?.close(),
      this.webhookWorker?.close(),
      this.domainQueue.close(),
      this.webhookQueue.close(),
    ]);
  }

  async ping(): Promise<string> {
    const client = await this.domainQueue.client;
    return client.ping();
  }

  async dispatchOutbox(): Promise<void> {
    if (this.dispatchingOutbox) return;
    this.dispatchingOutbox = true;

    try {
      const now = new Date();
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          publishedAt: null,
          nextPublishAt: { lte: now },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });

      for (const event of events) {
        await this.publishOutboxEvent(event);
      }
    } catch (error) {
      this.logger.warn(`Outbox dispatch cycle failed: ${this.errorMessage(error)}`);
    } finally {
      this.dispatchingOutbox = false;
    }
  }

  async dispatchWebhookDeliveries(): Promise<void> {
    if (this.dispatchingWebhooks) return;
    this.dispatchingWebhooks = true;

    try {
      const staleBefore = new Date(Date.now() - WEBHOOK_PROCESSING_STALE_MS);
      const deliveries = await this.prisma.webhookDelivery.findMany({
        where: {
          OR: [
            { status: WebhookDeliveryStatus.PENDING },
            {
              status: WebhookDeliveryStatus.PROCESSING,
              queuedAt: { lt: staleBefore },
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50,
        select: { id: true },
      });

      for (const delivery of deliveries) {
        try {
          await this.webhookQueue.add(
            'deliver-webhook',
            { deliveryId: delivery.id },
            {
              jobId: delivery.id,
              attempts: 5,
              backoff: { type: 'exponential', delay: 2_000 },
              removeOnComplete: { age: 86_400, count: 10_000 },
              removeOnFail: { age: 604_800, count: 10_000 },
            },
          );

          await this.prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: WebhookDeliveryStatus.PROCESSING,
              queuedAt: new Date(),
            },
          });
        } catch (error) {
          this.logger.warn(
            `Failed to enqueue webhook delivery ${delivery.id}: ${this.errorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`Webhook dispatch cycle failed: ${this.errorMessage(error)}`);
    } finally {
      this.dispatchingWebhooks = false;
    }
  }

  private async publishOutboxEvent(event: OutboxEvent): Promise<void> {
    try {
      await this.domainQueue.add(
        event.eventType,
        { outboxEventId: event.id },
        {
          jobId: event.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 86_400, count: 10_000 },
          removeOnFail: { age: 604_800, count: 10_000 },
        },
      );

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          publishedAt: new Date(),
          publishAttempts: { increment: 1 },
          lastError: null,
        },
      });
    } catch (error) {
      const attempt = event.publishAttempts + 1;
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
      await this.prisma.outboxEvent
        .update({
          where: { id: event.id },
          data: {
            publishAttempts: { increment: 1 },
            nextPublishAt: new Date(Date.now() + delayMs),
            lastError: this.errorMessage(error).slice(0, 500),
          },
        })
        .catch((updateError: unknown) => {
          this.logger.warn(
            `Failed to persist outbox retry metadata for ${event.id}: ${this.errorMessage(updateError)}`,
          );
        });
    }
  }

  private async processDomainEvent(job: Job): Promise<void> {
    const outboxEventId = this.requireJobId(job.data, 'outboxEventId');
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) {
      throw new Error(`Outbox event ${outboxEventId} no longer exists`);
    }

    const payload = this.parseDomainPayload(event.payload);
    const recipientIds = [...new Set([payload.senderUserId, payload.recipientUserId])];
    const amountText = `${payload.amountMinor} ${payload.currency} minor units`;

    await this.prisma.$transaction(async (transaction) => {
      const notifications = recipientIds.map((userId) => {
        const isSender = userId === payload.senderUserId;
        if (event.eventType === OutboxEventType.TRANSFER_COMPLETED) {
          return {
            userId,
            outboxEventId: event.id,
            eventType: event.eventType,
            title: isSender ? 'Transfer sent' : 'Transfer received',
            body: isSender
              ? `Your transfer ${payload.reference} for ${amountText} completed.`
              : `You received ${amountText} from transfer ${payload.reference}.`,
          };
        }

        return {
          userId,
          outboxEventId: event.id,
          eventType: event.eventType,
          title: isSender ? 'Transfer reversed' : 'Transfer reversal applied',
          body: isSender
            ? `Your transfer ${payload.reference} was reversed for ${amountText}.`
            : `A ${amountText} transfer to you was reversed.`,
        };
      });

      await transaction.notification.createMany({ data: notifications, skipDuplicates: true });

      const endpoints = await transaction.webhookEndpoint.findMany({
        where: {
          userId: { in: recipientIds },
          enabled: true,
        },
        select: { id: true },
      });

      if (endpoints.length > 0) {
        await transaction.webhookDelivery.createMany({
          data: endpoints.map((endpoint) => ({
            endpointId: endpoint.id,
            outboxEventId: event.id,
          })),
          skipDuplicates: true,
        });
      }
    });
  }

  private async processWebhookDelivery(job: Job): Promise<void> {
    const deliveryId = this.requireJobId(job.data, 'deliveryId');
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        endpoint: true,
        outboxEvent: true,
      },
    });

    if (!delivery || delivery.status === WebhookDeliveryStatus.SUCCEEDED) return;

    if (!delivery.endpoint.enabled) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          lastError: 'Webhook endpoint is disabled',
          lastAttemptAt: new Date(),
          attemptCount: { increment: 1 },
        },
      });
      return;
    }

    const envelope = {
      id: delivery.outboxEvent.id,
      type: delivery.outboxEvent.eventType,
      occurredAt: delivery.outboxEvent.occurredAt.toISOString(),
      data: delivery.outboxEvent.payload,
    };
    const rawBody = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = this.signing.sign(delivery.endpoint.id, timestamp, rawBody);
    const timeoutMs = this.config.get<number>('WEBHOOK_REQUEST_TIMEOUT_MS') ?? 5_000;
    const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    const finalAttempt = job.attemptsMade + 1 >= maxAttempts;

    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'fintech-transaction-platform/1.0',
          'x-fintech-event': delivery.outboxEvent.eventType,
          'x-fintech-delivery': delivery.id,
          'x-fintech-timestamp': timestamp,
          'x-fintech-signature': signature,
        },
        body: rawBody,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const message = `Webhook endpoint returned HTTP ${response.status}`;
        await this.recordWebhookFailure(delivery.id, message, finalAttempt, response.status);
        throw new Error(message);
      }

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.SUCCEEDED,
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          responseStatus: response.status,
          lastError: null,
          deliveredAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Webhook endpoint returned HTTP ')) {
        throw error;
      }

      const message = this.errorMessage(error).slice(0, 500);
      await this.recordWebhookFailure(delivery.id, message, finalAttempt, null);
      throw error;
    }
  }

  private async recordWebhookFailure(
    deliveryId: string,
    message: string,
    finalAttempt: boolean,
    responseStatus: number | null,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: finalAttempt ? WebhookDeliveryStatus.FAILED : WebhookDeliveryStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        responseStatus,
        lastError: message.slice(0, 500),
      },
    });
  }

  private parseDomainPayload(payload: Prisma.JsonValue): DomainEventPayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Outbox event payload must be an object');
    }

    const value = payload as Prisma.JsonObject;
    const required = [
      'senderUserId',
      'recipientUserId',
      'transferId',
      'reference',
      'amountMinor',
      'currency',
    ] as const;

    for (const key of required) {
      if (typeof value[key] !== 'string' || value[key].length === 0) {
        throw new Error(`Outbox event payload is missing ${key}`);
      }
    }

    const reversalId = value.reversalId;
    if (reversalId !== undefined && reversalId !== null && typeof reversalId !== 'string') {
      throw new Error('Outbox event reversalId must be a string when present');
    }

    return {
      senderUserId: value.senderUserId as string,
      recipientUserId: value.recipientUserId as string,
      transferId: value.transferId as string,
      reference: value.reference as string,
      amountMinor: value.amountMinor as string,
      currency: value.currency as string,
      ...(typeof reversalId === 'string' ? { reversalId } : {}),
    };
  }

  private requireJobId(data: unknown, key: string): string {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Queue job is missing ${key}`);
    }

    const value = (data as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Queue job is missing ${key}`);
    }

    return value;
  }

  private parseRedisConnection(redisUrl: string) {
    const url = new URL(redisUrl);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error('REDIS_URL must use redis:// or rediss://');
    }

    const dbText = url.pathname.replace(/^\//, '');
    const db = dbText ? Number(dbText) : 0;
    if (!Number.isInteger(db) || db < 0) {
      throw new Error('REDIS_URL database index must be a non-negative integer');
    }

    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      db,
      ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
      maxRetriesPerRequest: null,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
