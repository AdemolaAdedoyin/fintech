import { Global, Module } from '@nestjs/common';
import { AsyncHealthController } from './async-health.controller';
import { AsyncRuntimeService } from './async-runtime.service';
import { WebhookSigningService } from './webhook-signing.service';
import { WebhookTargetService } from './webhook-target.service';

@Global()
@Module({
  controllers: [AsyncHealthController],
  providers: [AsyncRuntimeService, WebhookSigningService, WebhookTargetService],
  exports: [AsyncRuntimeService, WebhookSigningService, WebhookTargetService],
})
export class AsyncModule {}
