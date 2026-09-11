import type { TransferReversal } from '@prisma/client';

export function toReversalResponse(reversal: TransferReversal) {
  return {
    id: reversal.id,
    reference: reversal.reference,
    transferId: reversal.transferId,
    ledgerTransactionId: reversal.ledgerTransactionId,
    currency: reversal.currency,
    amountMinor: reversal.amountMinor.toString(),
    reason: reversal.reason,
    createdAt: reversal.createdAt,
  };
}
