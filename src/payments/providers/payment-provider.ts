import type { Currency, PaymentProvider, PaymentStatus } from '@prisma/client';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
export interface PaymentInitialization {
  reference: string;
  amountMinor: string;
  currency: Currency;
}
export interface VerifiedPaymentEvent extends PaymentInitialization {
  eventId: string;
  status: Exclude<PaymentStatus, 'PENDING'>;
  payloadHash: string;
}

/** Adapters must use the persisted reference as their upstream idempotency key.
 * Initialization never proves settlement. Only a verified event may settle money.
 */
export interface PaymentProviderAdapter {
  readonly name: PaymentProvider;
  assertEnabled(): void;
  initialize(input: PaymentInitialization): Promise<{ checkoutUrl: string | null }>;
  verify(
    rawBody: Buffer,
    timestamp: string | undefined,
    signature: string | undefined,
  ): VerifiedPaymentEvent;
}
