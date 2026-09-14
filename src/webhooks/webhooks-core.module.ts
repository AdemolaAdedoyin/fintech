import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookTransportService } from './webhook-transport.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Module({
  imports: [PrismaModule],
  providers: [WebhookCryptoService, WebhookTransportService, WebhookDeliveryService],
  exports: [WebhookCryptoService, WebhookTransportService, WebhookDeliveryService],
})
export class WebhooksCoreModule {}
