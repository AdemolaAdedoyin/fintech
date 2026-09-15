import type { Payment } from '@prisma/client';

export function toPaymentResponse(payment: Payment) {
  return {
    id: payment.id,
    walletId: payment.walletId,
    provider: payment.provider,
    reference: payment.reference,
    amountMinor: payment.amountMinor.toString(),
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    completedAt: payment.completedAt,
  };
}
