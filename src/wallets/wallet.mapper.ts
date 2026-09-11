import type { Wallet } from '@prisma/client';

export interface WalletResponse {
  id: string;
  currency: Wallet['currency'];
  status: Wallet['status'];
  currentBalanceMinor: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    currency: wallet.currency,
    status: wallet.status,
    currentBalanceMinor: wallet.currentBalanceMinor.toString(),
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
