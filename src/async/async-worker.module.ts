import { WebhooksCoreModule } from '../webhooks/webhooks-core.module';
import { WebhookWorkerService } from '../webhooks/webhook-worker.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { AsyncWorkerService } from './async-worker.service';
import { NotificationService } from './notification.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    PrismaModule,
    WebhooksCoreModule,
  ],
  providers: [AsyncWorkerService, NotificationService, WebhookWorkerService],
  exports: [AsyncWorkerService, NotificationService, WebhookWorkerService],
})
export class AsyncWorkerModule {}
