import { Global, Module } from '@nestjs/common';
import { AsyncHealthController } from './async-health.controller';
import { AsyncRuntimeService } from './async-runtime.service';
import { WebhookSigningService } from './webhook-signing.service';

@Global()
@Module({
  controllers: [AsyncHealthController],
  providers: [AsyncRuntimeService, WebhookSigningService],
  exports: [AsyncRuntimeService, WebhookSigningService],
})
export class AsyncModule {}
