import type { Transfer } from '@prisma/client';

export function toTransferResponse(transfer: Transfer) {
  return {
    id: transfer.id,
    reference: transfer.reference,
    sourceWalletId: transfer.sourceWalletId,
    destinationWalletId: transfer.destinationWalletId,
    beneficiaryId: transfer.beneficiaryId,
    currency: transfer.currency,
    amountMinor: transfer.amountMinor.toString(),
    status: transfer.status,
    createdAt: transfer.createdAt,
    completedAt: transfer.completedAt,
  };
}
