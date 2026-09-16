import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MAX_MINOR_UNITS } from '../../ledger/ledger.invariants';
import type {
  PaymentInitialization,
  PaymentProviderAdapter,
  VerifiedPaymentEvent,
} from './payment-provider';

const eventSchema = z
  .object({
    eventId: z.string().uuid(),
    reference: z.string().regex(/^payment:[0-9a-f-]{36}$/),
    amountMinor: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_MINOR_UNITS),
    currency: z.enum(['USD', 'NGN']),
    status: z.enum(['SUCCEEDED', 'FAILED']),
  })
  .strict();

@Injectable()
export class MockPaymentProvider implements PaymentProviderAdapter {
  readonly name = 'MOCK' as const;
  constructor(private readonly config: ConfigService) {}

  assertEnabled(): void {
    if (
      this.config.get<string>('PAYMENT_PROVIDER') !== 'mock' ||
      this.config.get<string>('NODE_ENV') === 'production' ||
      (this.config.get<string>('MOCK_PROVIDER_WEBHOOK_SECRET')?.length ?? 0) < 32
    ) {
      throw new ServiceUnavailableException('Mock payment provider is disabled');
    }
  }

  initialize(input: PaymentInitialization): Promise<{ checkoutUrl: null }> {
    this.assertEnabled();
    if (!/^payment:[0-9a-f-]{36}$/.test(input.reference))
      throw new BadRequestException('Invalid payment reference');
    // No card data, hosted page, external request or automatic settlement in mock mode.
    return Promise.resolve({ checkoutUrl: null });
  }

  verify(
    rawBody: Buffer,
    timestamp: string | undefined,
    signature: string | undefined,
  ): VerifiedPaymentEvent {
    this.assertEnabled();
    if (!rawBody.length || rawBody.length > 16384)
      throw new BadRequestException('Invalid provider payload size');
    if (
      !timestamp ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 ||
      !signature ||
      !/^v1=[0-9a-f]{64}$/.test(signature)
    ) {
      throw new UnauthorizedException('Invalid provider signature');
    }
    const expected = createHmac(
      'sha256',
      this.config.getOrThrow<string>('MOCK_PROVIDER_WEBHOOK_SECRET'),
    )
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) {
      throw new UnauthorizedException('Invalid provider signature');
    }
    let input: unknown;
    try {
      input = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException('Invalid provider payload');
    }
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid provider payload');
    return { ...parsed.data, payloadHash: createHash('sha256').update(rawBody).digest('hex') };
  }
}
