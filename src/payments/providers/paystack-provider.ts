import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentInitialization, VerifiedPaymentEvent } from './payment-provider';

const referenceSchema = z.string().regex(/^payment-[0-9a-f-]{36}$/);
const transactionSchema = z.object({
  id: z.number().int().positive().safe(),
  reference: referenceSchema,
  amount: z.number().int().positive().safe(),
  currency: z.literal('NGN'),
  domain: z.enum(['test', 'live']),
  status: z.string(),
});

@Injectable()
export class PaystackProvider {
  constructor(private readonly config: ConfigService) {}

  assertEnabled(): void {
    const key = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (
      this.config.get<string>('PAYMENT_PROVIDER') !== 'paystack' ||
      !key ||
      !/^sk_(test|live)_[A-Za-z0-9]+$/.test(key) ||
      (key.startsWith('sk_live_') && this.config.get<string>('NODE_ENV') !== 'production')
    )
      throw new ServiceUnavailableException('Paystack provider is disabled');
  }

  validateIntent(amountMinor: string, currency: string): void {
    if (
      currency !== 'NGN' ||
      !/^[1-9][0-9]{0,15}$/.test(amountMinor) ||
      BigInt(amountMinor) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new BadRequestException(
        'Paystack requires NGN and a positive safely representable minor-unit amount',
      );
  }

  async initialize(input: PaymentInitialization, email: string): Promise<{ checkoutUrl: string }> {
    this.assertEnabled();
    this.validateIntent(input.amountMinor, input.currency);
    if (!referenceSchema.safeParse(input.reference).success)
      throw new BadRequestException('Invalid Paystack reference');
    const response = await this.request('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amountMinor,
        currency: input.currency,
        email,
      }),
    });
    const parsed = z
      .object({
        status: z.literal(true),
        data: z.object({
          reference: z.literal(input.reference),
          authorization_url: z
            .string()
            .max(512)
            .regex(/^https:\/\/checkout\.paystack\.com\/[A-Za-z0-9_-]+$/),
        }),
      })
      .safeParse(response);
    if (!parsed.success)
      throw new ServiceUnavailableException('Invalid Paystack initialization response');
    return { checkoutUrl: parsed.data.data.authorization_url };
  }

  webhookReference(raw: Buffer, signature: string | undefined): string | null {
    this.assertEnabled();
    if (!signature || !/^[a-fA-F0-9]{128}$/.test(signature) || !raw.length || raw.length > 65536)
      throw new UnauthorizedException('Invalid Paystack signature');
    const expected = createHmac('sha512', this.config.getOrThrow<string>('PAYSTACK_SECRET_KEY'))
      .update(raw)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      throw new UnauthorizedException('Invalid Paystack signature');
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException('Invalid Paystack payload');
    }
    const envelope = z.object({ event: z.string(), data: z.unknown() }).safeParse(payload);
    if (!envelope.success) throw new BadRequestException('Invalid Paystack event');
    if (envelope.data.event !== 'charge.success') return null;
    const data = z.object({ reference: z.string() }).safeParse(envelope.data.data);
    if (!data.success) throw new BadRequestException('Invalid Paystack reference');
    // Ignore references from other applications sharing this provider account.
    return referenceSchema.safeParse(data.data.reference).success ? data.data.reference : null;
  }

  async reconcile(reference: string): Promise<VerifiedPaymentEvent | null> {
    this.assertEnabled();
    if (!referenceSchema.safeParse(reference).success)
      throw new BadRequestException('Invalid Paystack reference');
    const result = await this.request(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
    });
    const parsed = z.object({ status: z.literal(true), data: transactionSchema }).safeParse(result);
    if (!parsed.success)
      throw new ServiceUnavailableException('Invalid Paystack verification response');
    const data = parsed.data.data;
    const domain = this.config.getOrThrow<string>('PAYSTACK_SECRET_KEY').startsWith('sk_test_')
      ? 'test'
      : 'live';
    if (data.reference !== reference || data.domain !== domain)
      throw new ServiceUnavailableException('Paystack verification identity mismatch');
    // Non-success states may still change; do not permanently fail an intent.
    if (data.status !== 'success') return null;
    const evidence = {
      eventId: `paystack:${data.id}:success`,
      reference,
      amountMinor: String(data.amount),
      currency: data.currency,
      status: 'SUCCEEDED' as const,
    };
    // Stable verification evidence makes webhook/reconciliation races identical.
    return {
      ...evidence,
      payloadHash: createHash('sha256')
        .update(JSON.stringify({ ...evidence, domain }))
        .digest('hex'),
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${this.config.getOrThrow<string>('PAYSTACK_SECRET_KEY')}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok || !response.body) throw new Error('Provider request failed');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error('Provider response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Never include response bodies, card authorization data or the API key.
      throw new ServiceUnavailableException(
        'Paystack request unavailable; reconcile the original payment',
      );
    }
  }
}
