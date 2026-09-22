import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class OperationalRedis implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      connectTimeout: 1000,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on('error', () => {
      /* Readiness reports dependency failures without credentials. */
    });
  }
  async onModuleInit() {
    await this.client.connect().catch(() => undefined);
  }
  onModuleDestroy() {
    this.client.disconnect();
  }
}
