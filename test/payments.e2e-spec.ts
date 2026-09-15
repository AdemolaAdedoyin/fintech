import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Currency } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { NotificationService } from '../src/async/notification.service';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/auth.constants';
import { LedgerService } from '../src/ledger/ledger.service';
import { MockPaymentProvider } from '../src/payments/providers/mock-payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletsService } from '../src/wallets/wallets.service';

interface PaymentBody {
  id: string;
  reference: string;
  status: string;
  currency: Currency;
  amountMinor: string;
  checkoutUrl: null;
}
interface CallbackBody {
  eventId: string;
  reference: string;
  amountMinor: string;
  currency: Currency;
  status: 'SUCCEEDED' | 'FAILED';
}
interface Page {
  items: { id: string }[];
  nextCursor: string | null;
}
const secret = 'private-provider-e2e-secret-longer-than-thirty-two-characters';

describe('Mock provider payments (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let config: ConfigService;
  let provider: MockPaymentProvider;
  let userId: string;
  let walletId: string;
  let token: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    config = app.get(ConfigService);
    config.set('PAYMENT_PROVIDER', 'mock');
    config.set('NODE_ENV', 'test');
    config.set('MOCK_PROVIDER_WEBHOOK_SECRET', secret);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    provider = app.get(MockPaymentProvider);
  });
  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        email: `payment-${randomUUID()}@example.com`,
        passwordHash: 'unused',
        firstName: 'Payment',
        lastName: 'Test',
      },
    });
    userId = user.id;
    const wallet = await app.get(WalletsService).create(userId, Currency.USD);
    walletId = wallet.id;
    token = app.get(JwtService).sign(
      { sub: userId, type: 'access' },
      {
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    config.set('PAYMENT_PROVIDER', 'mock');
    config.set('NODE_ENV', 'test');
  });
  afterAll(async () => {
    await app?.close();
  });

  function initialize(key = randomUUID(), amountMinor = '2500', target = walletId) {
    return request(server)
      .post('/api/v1/payments')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ walletId: target, amountMinor });
  }
  async function payment(amount = '2500', target = walletId): Promise<PaymentBody> {
    return (await initialize(randomUUID(), amount, target).expect(201)).body as PaymentBody;
  }
  function callback(p: PaymentBody, status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): CallbackBody {
    return {
      reference: p.reference,
      amountMinor: p.amountMinor,
      currency: p.currency,
      eventId: randomUUID(),
      status,
    };
  }
  function send(event: CallbackBody, signingSecret = secret) {
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex')}`;
    return request(server)
      .post('/api/v1/payments/webhooks/mock')
      .set('Content-Type', 'application/json')
      .set('Mock-Timestamp', timestamp)
      .set('Mock-Signature', signature)
      .send(raw);
  }
  function balance(id = walletId) {
    return prisma.wallet.findUniqueOrThrow({ where: { id } }).then((w) => w.currentBalanceMinor);
  }

  it('persists pending intent without money movement and replays simultaneous initialization', async () => {
    const key = randomUUID();
    const responses = await Promise.all([initialize(key), initialize(key)]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const first = responses[0].body as PaymentBody;
    expect((responses[1].body as PaymentBody).id).toBe(first.id);
    expect(first).toMatchObject({
      status: 'PENDING',
      amountMinor: '2500',
      currency: 'USD',
      checkoutUrl: null,
    });
    expect(await balance()).toBe(0n);
    expect(await prisma.ledgerTransaction.count({ where: { reference: first.reference } })).toBe(0);
    await initialize(key, '2501').expect(409);
  });

  it('keeps a stable reference across provider initialization outages', async () => {
    const key = randomUUID();
    const init = jest
      .spyOn(provider, 'initialize')
      .mockRejectedValueOnce(new Error('provider unavailable'));
    await initialize(key).expect(503);
    const pending = await prisma.payment.findUniqueOrThrow({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
    const retried = (await initialize(key).expect(201)).body as PaymentBody;
    expect(retried.reference).toBe(pending.reference);
    expect(init).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reference: pending.reference }),
    );
    expect(init).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reference: pending.reference }),
    );
    expect(await balance()).toBe(0n);
  });

  it('credits once for repeated and concurrent signed callbacks', async () => {
    const p = await payment();
    const event = callback(p);
    const responses = await Promise.all([send(event), send(event), send(event)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    await send(event).expect(200);
    await send({ ...event, eventId: randomUUID() }).expect(200);
    expect(await balance()).toBe(2500n);
    expect(await prisma.providerEvent.count({ where: { paymentId: p.id } })).toBe(2);
    expect(await prisma.ledgerTransaction.count({ where: { reference: p.reference } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: p.id } })).toBe(1);
    const stored = await prisma.payment.findUniqueOrThrow({
      where: { id: p.id },
      include: { ledgerTransaction: { include: { postings: true } } },
    });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.ledgerTransaction?.postings.map((posting) => posting.amountMinor).sort()).toEqual(
      [-2500n, 2500n],
    );
  });

  it('records failure without credit and rejects contradictory terminal results', async () => {
    const p = await payment();
    await send(callback(p, 'FAILED')).expect(200);
    await send(callback(p, 'FAILED')).expect(200);
    await send(callback(p)).expect(409);
    expect(await balance()).toBe(0n);
    expect(await prisma.ledgerTransaction.count({ where: { reference: p.reference } })).toBe(0);
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: p.id, type: 'PAYMENT_FAILED' } }),
    ).toBe(1);
  });

  it('rejects unknown references, bad signatures and signed amount/currency mismatches atomically', async () => {
    const p = await payment();
    const event = callback(p);
    await send(event, 'wrong-secret-longer-than-thirty-two-characters').expect(401);
    await request(server).post('/api/v1/payments/webhooks/mock').send(event).expect(401);
    await send({ ...event, reference: `payment:${randomUUID()}` }).expect(404);
    await send({ ...event, amountMinor: '2501' }).expect(409);
    await send({ ...event, currency: 'NGN' }).expect(409);
    expect(await balance()).toBe(0n);
    expect(await prisma.providerEvent.count({ where: { paymentId: p.id } })).toBe(0);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'PENDING',
    );
  });

  it('rejects event ID reuse across requests or changed payloads', async () => {
    const first = await payment();
    const second = await payment();
    const event = callback(first);
    await send(event).expect(200);
    await send({ ...callback(second), eventId: event.eventId }).expect(409);
    await send({ ...event, status: 'FAILED' }).expect(409);
    expect(await balance()).toBe(2500n);
  });

  it('handles simultaneous distinct payments without losing balance updates', async () => {
    const a = await payment('100');
    const b = await payment('200');
    const responses = await Promise.all([send(callback(a)), send(callback(b))]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await balance()).toBe(300n);
  });

  it('does not settle a closed wallet, and leaves the callback unconsumed', async () => {
    const p = await payment();
    await app.get(WalletsService).close(userId, walletId);
    await send(callback(p)).expect(409);
    expect(await balance()).toBe(0n);
    expect(await prisma.providerEvent.count({ where: { paymentId: p.id } })).toBe(0);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'PENDING',
    );
  });

  it('serializes wallet closing against successful funding', async () => {
    const p = await payment();
    const [settled] = await Promise.all([
      send(callback(p)),
      app
        .get(WalletsService)
        .close(userId, walletId)
        .catch(() => null),
    ]);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (settled.status === 200)
      expect(wallet).toMatchObject({ status: 'ACTIVE', currentBalanceMinor: 2500n });
    else {
      expect(settled.status).toBe(409);
      expect(wallet).toMatchObject({ status: 'CLOSED', currentBalanceMinor: 0n });
    }
  });

  it('rolls back settlement when a failure follows ledger writes', async () => {
    const p = await payment();
    const spy = jest.spyOn(app.get(LedgerService), 'postWithinTransaction');
    const original = app.get(LedgerService).postWithinTransaction.bind(app.get(LedgerService));
    spy.mockImplementationOnce(async (tx, input) => {
      const result = await original(tx, input);
      // Test-only failure after accounting writes; transaction must roll everything back.
      throw new Error(`simulated failure after ${result.id}`);
    });
    await send(callback(p)).expect(500);
    expect(await balance()).toBe(0n);
    expect(await prisma.ledgerTransaction.count({ where: { reference: p.reference } })).toBe(0);
    expect(await prisma.providerEvent.count({ where: { paymentId: p.id } })).toBe(0);
    spy.mockRestore();
    await send(callback(p)).expect(200);
    expect(await balance()).toBe(2500n);
  });

  it('preserves minor units beyond JavaScript safe integers', async () => {
    const p = await payment('9007199254740993');
    await send(callback(p)).expect(200);
    expect(await balance()).toBe(9007199254740993n);
    const read = await request(server)
      .get(`/api/v1/payments/${p.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((read.body as PaymentBody).amountMinor).toBe('9007199254740993');
  });

  it('rejects malformed amounts, missing keys and attempts to choose identity or provider', async () => {
    for (const amount of ['0', '-1', '01', '1.5', '9223372036854775808'])
      await initialize(randomUUID(), amount).expect(400);
    await request(server)
      .post('/api/v1/payments')
      .auth(token, { type: 'bearer' })
      .send({ walletId, amountMinor: '1' })
      .expect(400);
    await request(server)
      .post('/api/v1/payments')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ walletId, amountMinor: '1', userId, provider: 'MOCK' })
      .expect(400);
    await initialize(randomUUID(), '1', randomUUID()).expect(404);
    await request(server).get('/api/v1/payments').expect(401);
  });

  it('scopes access and pagination while hiding internal hashes and idempotency keys', async () => {
    const a = await payment();
    const b = await payment();
    const page = await request(server)
      .get('/api/v1/payments?limit=1')
      .auth(token, { type: 'bearer' })
      .expect(200);
    const first = page.body as Page;
    expect(first.items).toHaveLength(1);
    const second = await request(server)
      .get(`/api/v1/payments?limit=1&cursor=${first.nextCursor}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((second.body as Page).items[0].id).not.toBe(first.items[0].id);
    expect(JSON.stringify(page.body)).not.toMatch(/requestHash|idempotencyKey|secret/i);
    await send(callback(a)).expect(200);
    const history = await request(server)
      .get(`/api/v1/payments/${a.id}/events`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((history.body as Page).items).toHaveLength(1);
    expect(JSON.stringify(history.body)).not.toMatch(/payloadHash|signature|secret/i);
    await request(server)
      .get(`/api/v1/payments/${b.id}/events?cursor=${(history.body as Page).items[0].id}`)
      .auth(token, { type: 'bearer' })
      .expect(400);
    const stranger = await prisma.user.create({
      data: {
        email: `stranger-${randomUUID()}@example.com`,
        passwordHash: 'unused',
        firstName: 'Other',
        lastName: 'User',
      },
    });
    const otherToken = app.get(JwtService).sign(
      { sub: stranger.id, type: 'access' },
      {
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    await request(server)
      .get(`/api/v1/payments/${a.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(404);
    await request(server)
      .get(`/api/v1/payments?cursor=${a.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(400);
    await request(server)
      .post('/api/v1/payments')
      .auth(otherToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ walletId, amountMinor: '1' })
      .expect(404);
  });

  it('feeds payment notifications and outbound webhook fan-out atomically', async () => {
    const subscription = await prisma.webhookSubscription.create({
      data: { userId, url: 'https://example.com', encryptedSecret: 'unused-in-this-test' },
    });
    try {
      for (const status of ['SUCCEEDED', 'FAILED'] as const) {
        const p = await payment();
        await send(callback(p, status)).expect(200);
        const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: p.id } });
        expect(event.type).toBe(`PAYMENT_${status}`);
        expect(
          await prisma.webhookDelivery.count({
            where: { subscriptionId: subscription.id, outboxEventId: event.id },
          }),
        ).toBe(1);
        const notification = await new NotificationService(prisma).persistForEvent(event.id);
        expect(notification.type).toBe(`PAYMENT_${status}`);
      }
    } finally {
      await prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { enabled: false },
      });
      await prisma.webhookDelivery.updateMany({
        where: { subscriptionId: subscription.id },
        data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
      });
    }
  });

  it('enforces payment and provider evidence immutability in PostgreSQL', async () => {
    const p = await payment();
    await expect(
      prisma.payment.update({ where: { id: p.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.payment_write', 'on', true)`;
        await tx.payment.update({
          where: { id: p.id },
          data: { status: 'FAILED', completedAt: new Date() },
        });
      }),
    ).rejects.toThrow();
    await send(callback(p)).expect(200);
    await expect(prisma.payment.delete({ where: { id: p.id } })).rejects.toThrow();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.payment_write', 'on', true)`;
        await tx.payment.update({
          where: { id: p.id },
          data: { status: 'FAILED', ledgerTransactionId: null },
        });
      }),
    ).rejects.toThrow();
    const event = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id } });
    await expect(prisma.providerEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(
      prisma.providerEvent.update({ where: { id: event.id }, data: { eventId: randomUUID() } }),
    ).rejects.toThrow();
  });

  it('rejects a successful payment linked to the wrong ledger amount at commit', async () => {
    const p = await payment('100');
    const ledger = app.get(LedgerService);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.payment_write', 'on', true)`;
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
        const clearing = await ledger.getExternalClearingAccount(Currency.USD);
        const posting = await ledger.postWithinTransaction(tx, {
          reference: p.reference,
          currency: Currency.USD,
          postings: [
            { accountId: clearing.id, amountMinor: -200n },
            { accountId: wallet.ledgerAccountId, amountMinor: 200n },
          ],
        });
        await tx.providerEvent.create({
          data: {
            paymentId: p.id,
            provider: 'MOCK',
            eventId: randomUUID(),
            payloadHash: 'a'.repeat(64),
            status: 'SUCCEEDED',
          },
        });
        await tx.payment.update({
          where: { id: p.id },
          data: { status: 'SUCCEEDED', ledgerTransactionId: posting.id, completedAt: new Date() },
        });
        await tx.outboxEvent.create({
          data: {
            type: 'PAYMENT_SUCCEEDED',
            aggregateType: 'Payment',
            aggregateId: p.id,
            actorUserId: userId,
            payload: {},
          },
        });
      }),
    ).rejects.toThrow();
    expect(await balance()).toBe(0n);
    expect(await prisma.ledgerTransaction.count({ where: { reference: p.reference } })).toBe(0);
  });

  it('rejects mock initiation and callbacks while disabled or in production', async () => {
    const p = await payment();
    config.set('PAYMENT_PROVIDER', 'disabled');
    await initialize().expect(503);
    await send(callback(p)).expect(503);
    config.set('PAYMENT_PROVIDER', 'mock');
    config.set('NODE_ENV', 'production');
    await initialize().expect(503);
    await send(callback(p)).expect(503);
    expect(await balance()).toBe(0n);
  });
});
