import { UsersModule } from '../users/users.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [AuthModule, UsersModule, WebhooksCoreModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
