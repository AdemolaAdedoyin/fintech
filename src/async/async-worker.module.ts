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
  ],
  providers: [AsyncWorkerService, NotificationService],
  exports: [AsyncWorkerService, NotificationService],
})
export class AsyncWorkerModule {}
