import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController, PaymentWebhooksController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockPaymentProvider } from './providers/mock-payment-provider';
import { PaystackProvider } from './providers/paystack-provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider';

@Module({
  imports: [AuthModule, UsersModule, LedgerModule],
  providers: [
    PaymentsService,
    PaystackProvider,
    MockPaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProvider },
  ],
  controllers: [PaymentsController, PaymentWebhooksController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
