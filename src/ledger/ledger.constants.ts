import { Currency } from '@prisma/client';

export function externalClearingAccountKey(currency: Currency): string {
  return `external-clearing:${currency}`;
}
