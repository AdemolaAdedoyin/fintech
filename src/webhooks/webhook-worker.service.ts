import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookDeliveryService, type WebhookJobData } from './webhook-delivery.service';

export const WEBHOOK_QUEUE = 'webhook-deliveries';

@Injectable()
export class WebhookWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookWorkerService.name);
  private queue?: Queue<WebhookJobData>;
  private worker?: Worker<WebhookJobData>;
  private producer?: IORedis;
  private consumer?: IORedis;
  private timer?: NodeJS.Timeout;
  private dispatch?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly crypto: WebhookCryptoService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.crypto.enabled) {
      this.logger.warn('Webhook delivery disabled: signing key is not configured');
      return;
    }
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      commandTimeout: 2000,
    });
    this.consumer = new IORedis(url, { maxRetriesPerRequest: null });
    this.producer.on('error', () => this.logger.warn('Webhook producer Redis unavailable'));
    this.consumer.on('error', () => this.logger.warn('Webhook consumer Redis unavailable'));
    this.queue = new Queue<WebhookJobData>(WEBHOOK_QUEUE, { connection: this.producer });
    this.worker = new Worker<WebhookJobData>(
      WEBHOOK_QUEUE,
      (job) => this.deliveries.execute(job.data),
      { connection: this.consumer, concurrency: 5 },
    );
    this.queue.on('error', () => this.logger.warn('Webhook queue unavailable'));
    this.worker.on('error', () => this.logger.warn('Webhook worker unavailable'));
    this.worker.on('failed', () =>
      this.logger.warn('Webhook job failed; database lease recovery will retry'),
    );
    await this.dispatchOnce();
    this.timer = setInterval(
      () => void this.dispatchOnce(),
      this.config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS'),
    );
    this.timer.unref();
  }

  dispatchOnce(): Promise<void> {
    if (this.stopping || !this.queue) return Promise.resolve();
    if (this.dispatch) return this.dispatch;
    this.dispatch = this.publishBatch()
      .catch(() => {
        this.logger.warn('Webhook dispatch failed; database lease recovery will retry');
      })
      .finally(() => {
        this.dispatch = undefined;
      });
    return this.dispatch;
  }

  private async publishBatch(): Promise<void> {
    // Do not spend claims on a Redis connection that is already known to be offline.
    if (this.producer?.status !== 'ready') return;
    const jobs = await this.deliveries.claimBatch();
    for (const job of jobs) {
      try {
        await this.queue!.add('deliver', job, {
          jobId: `${job.deliveryId}-${job.leaseToken}`,
          attempts: 1,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        });
      } catch {
        await this.deliveries.publicationFailed(job);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.dispatch;
    try {
      await this.worker?.close();
      await this.queue?.close();
    } finally {
      this.producer?.disconnect();
      this.consumer?.disconnect();
    }
  }
}
