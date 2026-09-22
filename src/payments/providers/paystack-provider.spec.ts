import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PaystackProvider } from './paystack-provider';

const key = 'sk_test_unitfixture';
const reference = 'payment-00000000-0000-4000-8000-000000000001';
const transaction = {
  id: 1234,
  reference,
  amount: 10000,
  currency: 'NGN',
  domain: 'test',
  status: 'success',
};
describe('Paystack provider', () => {
  let config: ConfigService;
  let provider: PaystackProvider;
  beforeEach(() => {
    config = new ConfigService({
      PAYMENT_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: key,
      NODE_ENV: 'test',
    });
    provider = new PaystackProvider(config);
  });
  afterEach(() => jest.restoreAllMocks());
  function respond(data: unknown) {
    return jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: true, data })));
  }
  it('initializes hosted checkout with the original amount, currency and reference', async () => {
    const fetch = respond({
      reference,
      authorization_url: 'https://checkout.paystack.com/test123',
    });
    await expect(
      provider.initialize(
        { reference, amountMinor: '10000', currency: 'NGN' },
        'owner@example.com',
      ),
    ).resolves.toEqual({ checkoutUrl: 'https://checkout.paystack.com/test123' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        redirect: 'error',
        body: JSON.stringify({
          reference,
          amount: '10000',
          currency: 'NGN',
          email: 'owner@example.com',
        }),
      }),
    );
  });
  it.each([
    'https://evil.example/checkout',
    'https://checkout.paystack.com.evil.example/test',
    'http://checkout.paystack.com/test',
  ])('rejects unexpected checkout URL %s', async (url) => {
    respond({ reference, authorization_url: url });
    await expect(
      provider.initialize(
        { reference, amountMinor: '10000', currency: 'NGN' },
        'owner@example.com',
      ),
    ).rejects.toThrow();
  });
  it('authenticates the raw webhook bytes', () => {
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference } }));
    const signature = createHmac('sha512', key).update(raw).digest('hex');
    expect(provider.webhookReference(raw, signature)).toBe(reference);
    expect(() =>
      provider.webhookReference(Buffer.concat([raw, Buffer.from(' ')]), signature),
    ).toThrow();
    expect(() => provider.webhookReference(raw, undefined)).toThrow();
  });
  it('acknowledges authenticated unrelated events without creating success evidence', () => {
    const raw = Buffer.from(JSON.stringify({ event: 'refund.processed', data: { reference } }));
    expect(
      provider.webhookReference(raw, createHmac('sha512', key).update(raw).digest('hex')),
    ).toBeNull();
  });
  it('uses stable evidence across verification responses with irrelevant field differences', async () => {
    const fetch = respond(transaction);
    const first = await provider.reconcile(reference);
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          data: { ...transaction, authorization: { authorization_code: 'never-store-this' } },
        }),
      ),
    );
    expect(await provider.reconcile(reference)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('authorization');
  });
  it.each(['pending', 'abandoned', 'failed', 'ongoing'])('does not settle %s', async (status) => {
    respond({ ...transaction, status });
    expect(await provider.reconcile(reference)).toBeNull();
  });
  it.each([
    { domain: 'live' },
    { reference: reference.replace('000001', '000002') },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { amount: -1 },
    { currency: 'USD' },
  ])('rejects unsafe verification evidence %j', async (changes) => {
    respond({ ...transaction, ...changes });
    await expect(provider.reconcile(reference)).rejects.toThrow();
  });
  it('bounds response size and hides upstream errors', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(65537)));
    await expect(provider.reconcile(reference)).rejects.toThrow('Paystack request unavailable');
  });
  it('rejects unsupported currency and unsafe amount before network I/O', () => {
    expect(() => provider.validateIntent('100', 'USD')).toThrow();
    expect(() => provider.validateIntent('9007199254740992', 'NGN')).toThrow();
  });
  it('blocks live keys outside production and disabled provider', () => {
    config.set('PAYSTACK_SECRET_KEY', 'sk_live_fixture');
    expect(() => provider.assertEnabled()).toThrow();
    config.set('NODE_ENV', 'production');
    expect(() => provider.assertEnabled()).not.toThrow();
    config.set('PAYMENT_PROVIDER', 'disabled');
    expect(() => provider.assertEnabled()).toThrow();
  });
});
