import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus, Prisma, type OutboxEvent } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_JOB, NOTIFICATION_QUEUE } from './async.constants';
import { NotificationService } from './notification.service';

interface NotificationJobData {
  eventId: string;
}

@Injectable()
export class AsyncWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsyncWorkerService.name);
  private queue?: Queue<NotificationJobData>;
  private worker?: Worker<NotificationJobData>;
  private queueRedis?: IORedis;
  private workerRedis?: IORedis;
  private pollTimer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.getOrThrow<string>('REDIS_URL');
    this.queueRedis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.workerRedis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE, {
      connection: this.queueRedis,
    });
    this.worker = new Worker<NotificationJobData>(
      NOTIFICATION_QUEUE,
      (job) => this.persistNotification(job),
      { connection: this.workerRedis, concurrency: 10 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Notification job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });

    await this.dispatchOnce();
    const interval = this.config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    this.pollTimer = setInterval(() => void this.dispatchOnce(), interval);
    this.pollTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all([this.workerRedis?.quit(), this.queueRedis?.quit()]);
  }

  async dispatchOnce(): Promise<void> {
    if (this.dispatching || !this.queue) return;
    this.dispatching = true;

    try {
      const events = await this.claimBatch();
      for (const event of events) await this.publish(event);
    } finally {
      this.dispatching = false;
    }
  }

  private claimBatch(): Promise<OutboxEvent[]> {
    return this.prisma.$queryRaw<OutboxEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE
          ("status" = 'PENDING' AND "availableAt" <= CURRENT_TIMESTAMP)
          OR ("status" = 'PROCESSING' AND "lockedAt" < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
        ORDER BY "createdAt" ASC
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" event
      SET "status" = 'PROCESSING', "lockedAt" = CURRENT_TIMESTAMP, "lastError" = NULL
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING event.*
    `);
  }

  private async publish(event: OutboxEvent): Promise<void> {
    try {
      await this.queue!.add(
        NOTIFICATION_JOB,
        { eventId: event.id },
        {
          jobId: event.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: OutboxStatus.PUBLISHED, lockedAt: null, publishedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown queue publishing error';
      const delayMs = Math.min(2 ** Math.min(event.attempts, 6) * 1_000, 60_000);
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OutboxStatus.PENDING,
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + delayMs),
          lockedAt: null,
          lastError: message.slice(0, 500),
        },
      });
      this.logger.warn(`Outbox event ${event.id} will be retried: ${message}`);
    }
  }

  private async persistNotification(job: Job<NotificationJobData>): Promise<void> {
    await this.notifications.persistForEvent(job.data.eventId);
  }
}
