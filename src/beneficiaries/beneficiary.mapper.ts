import type { Beneficiary, Wallet } from '@prisma/client';

export function toBeneficiaryResponse(
  beneficiary: Beneficiary & { wallet: Pick<Wallet, 'currency'> },
) {
  return {
    id: beneficiary.id,
    walletId: beneficiary.walletId,
    label: beneficiary.label,
    currency: beneficiary.wallet.currency,
    createdAt: beneficiary.createdAt,
  };
}
