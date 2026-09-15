import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { MockPaymentProvider } from './mock-payment-provider';

const secret = 'private-mock-test-secret-longer-than-32-characters';
const provider = new MockPaymentProvider(
  new ConfigService({
    PAYMENT_PROVIDER: 'mock',
    NODE_ENV: 'test',
    MOCK_PROVIDER_WEBHOOK_SECRET: secret,
  }),
);
const valid = () => ({
  eventId: randomUUID(),
  reference: `payment:${randomUUID()}`,
  amountMinor: '100',
  currency: 'USD',
  status: 'SUCCEEDED',
});
function signed(body: string, timestamp = Math.floor(Date.now() / 1000).toString()) {
  return {
    body: Buffer.from(body),
    timestamp,
    signature: `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
  };
}

describe('Mock provider verification', () => {
  it('verifies the exact raw bytes and parses only known fields', () => {
    const event = valid();
    const raw = JSON.stringify(event, null, 2);
    const { body, timestamp, signature } = signed(raw);
    expect(provider.verify(body, timestamp, signature)).toMatchObject(event);
    expect(() => provider.verify(Buffer.from(JSON.stringify(event)), timestamp, signature)).toThrow(
      'signature',
    );
  });
  it.each([-301, 301])('rejects timestamp offset %i seconds', (offset) => {
    const { body, timestamp, signature } = signed(
      JSON.stringify(valid()),
      String(Math.floor(Date.now() / 1000) + offset),
    );
    expect(() => provider.verify(body, timestamp, signature)).toThrow('signature');
  });
  it.each([undefined, '', 'v1=short', `v1=${'0'.repeat(64)}`, `v1=${'z'.repeat(64)}`])(
    'rejects invalid signature %s',
    (signature) => {
      const { body, timestamp } = signed(JSON.stringify(valid()));
      expect(() => provider.verify(body, timestamp, signature)).toThrow('signature');
    },
  );
  it.each(['0', '-1', '1.5', 'abc', '9223372036854775808', '01'])(
    'rejects invalid amount %s without throwing a parsing error',
    (amountMinor) => {
      const { body, timestamp, signature } = signed(JSON.stringify({ ...valid(), amountMinor }));
      expect(() => provider.verify(body, timestamp, signature)).toThrow('Invalid provider payload');
    },
  );
  it('rejects unknown fields, statuses, malformed JSON and oversized payloads', () => {
    for (const raw of [
      JSON.stringify({ ...valid(), walletId: randomUUID() }),
      JSON.stringify({ ...valid(), status: 'PENDING' }),
      '{',
      ' '.repeat(16385),
    ]) {
      const { body, timestamp, signature } = signed(raw);
      expect(() => provider.verify(body, timestamp, signature)).toThrow('Invalid provider payload');
    }
  });
  it.each([
    { PAYMENT_PROVIDER: 'disabled', NODE_ENV: 'test', MOCK_PROVIDER_WEBHOOK_SECRET: secret },
    { PAYMENT_PROVIDER: 'mock', NODE_ENV: 'production', MOCK_PROVIDER_WEBHOOK_SECRET: secret },
    { PAYMENT_PROVIDER: 'mock', NODE_ENV: 'test' },
  ])('fails closed for unavailable configuration', (config) => {
    const unavailable = new MockPaymentProvider(new ConfigService(config));
    expect(() => unavailable.assertEnabled()).toThrow('disabled');
  });
  it('initialization returns no hosted page or settlement claim', async () => {
    await expect(
      provider.initialize({
        reference: `payment:${randomUUID()}`,
        amountMinor: '100',
        currency: 'USD',
      }),
    ).resolves.toEqual({ checkoutUrl: null });
  });
});
