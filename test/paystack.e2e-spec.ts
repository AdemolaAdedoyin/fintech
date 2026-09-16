import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Currency } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/auth.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletsService } from '../src/wallets/wallets.service';

interface PaymentBody {
  id: string;
  reference: string;
  status: string;
  checkoutUrl: string;
}
const key = 'sk_test_e2efixture';
describe('Paystack funding (e2e)', () => {
  let app: INestApplication, server: Server, prisma: PrismaService, config: ConfigService;
  let userId: string, walletId: string, token: string;
  let fetchMock: jest.SpyInstance;
  let transactionId = 70000;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    config = app.get(ConfigService);
    config.set('PAYMENT_PROVIDER', 'paystack');
    config.set('PAYSTACK_SECRET_KEY', key);
    config.set('NODE_ENV', 'test');
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        email: `paystack-${randomUUID()}@example.com`,
        passwordHash: 'unused',
        firstName: 'Paystack',
        lastName: 'Test',
      },
    });
    userId = user.id;
    walletId = (await app.get(WalletsService).create(userId, Currency.NGN)).id;
    token = app.get(JwtService).sign(
      { sub: userId, type: 'access' },
      {
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const input = JSON.parse(init?.body as string) as { reference: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: true,
            data: {
              reference: input.reference,
              authorization_url: 'https://checkout.paystack.com/e2efixture',
            },
          }),
        ),
      );
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
  });
  const create = (idempotency = randomUUID()) =>
    request(server)
      .post('/api/v1/payments')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', idempotency)
      .send({ walletId, amountMinor: '12000' });
  function verify(payment: PaymentBody, changes: Record<string, unknown> = {}) {
    const data = {
      id: ++transactionId,
      reference: payment.reference,
      amount: 12000,
      currency: 'NGN',
      domain: 'test',
      status: 'success',
      ...changes,
    };
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ status: true, data }))),
    );
  }
  function webhook(payment: PaymentBody, valid = true) {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { reference: payment.reference },
    });
    return request(server)
      .post('/api/v1/payments/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        valid ? createHmac('sha512', key).update(body).digest('hex') : '0'.repeat(128),
      )
      .send(body);
  }
  const reconcile = (id: string) =>
    request(server).post(`/api/v1/payments/${id}/reconcile`).auth(token, { type: 'bearer' });
  it('persists and reuses checkout without initializing again or crediting money', async () => {
    const idempotency = randomUUID();
    const first = await create(idempotency).expect(201);
    const payment = first.body as PaymentBody;
    expect((await create(idempotency).expect(201)).body).toEqual(first.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await prisma.paymentCheckout.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).currentBalanceMinor,
    ).toBe(0n);
  });
  it('protects durable claims and cached URLs from deletion or replacement', async () => {
    const payment = (await create().expect(201)).body as PaymentBody;
    await expect(
      prisma.paymentCheckout.delete({ where: { paymentId: payment.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentCheckout.update({
        where: { paymentId: payment.id },
        data: { checkoutUrl: null },
      }),
    ).rejects.toThrow();
  });

  it('credits exactly once when webhook, replay and owner reconciliation race', async () => {
    const payment = (await create().expect(201)).body as PaymentBody;
    verify(payment);
    await Promise.all([
      webhook(payment).expect(200),
      webhook(payment).expect(200),
      reconcile(payment.id).expect(200),
    ]);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).currentBalanceMinor,
    ).toBe(12000n);
    expect(await prisma.providerEvent.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await prisma.ledgerTransaction.count({ where: { reference: payment.reference } })).toBe(
      1,
    );
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: payment.id, type: 'PAYMENT_SUCCEEDED' },
      }),
    ).toBe(1);
  });
  it('rejects forged callbacks before any verification request', async () => {
    const payment = (await create().expect(201)).body as PaymentBody;
    fetchMock.mockClear();
    await webhook(payment, false).expect(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps amount mismatch and non-success verification uncredited', async () => {
    const payment = (await create().expect(201)).body as PaymentBody;
    verify(payment, { amount: 11999 });
    await webhook(payment).expect(409);
    verify(payment, { status: 'pending' });
    expect(((await reconcile(payment.id).expect(200)).body as PaymentBody).status).toBe('PENDING');
    await webhook(payment).expect(503);
    expect(await prisma.providerEvent.count({ where: { paymentId: payment.id } })).toBe(0);
  });
  it('never repeats an uncertain initialization and can reconcile later success', async () => {
    const idempotency = randomUUID();
    fetchMock.mockRejectedValue(new Error('lost upstream response'));
    await create(idempotency).expect(503);
    await create(idempotency).expect(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { userId_idempotencyKey: { userId, idempotencyKey: idempotency } },
    });
    verify({ ...payment, checkoutUrl: '' });
    await reconcile(payment.id).expect(200);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).currentBalanceMinor,
    ).toBe(12000n);
  });
  it('checks ownership before reconciliation calls the provider', async () => {
    fetchMock.mockClear();
    await reconcile(randomUUID()).expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not consume success evidence if the wallet is closed', async () => {
    const payment = (await create().expect(201)).body as PaymentBody;
    await app.get(WalletsService).close(userId, walletId);
    verify(payment);
    await webhook(payment).expect(409);
    expect(await prisma.providerEvent.count({ where: { paymentId: payment.id } })).toBe(0);
  });
});
