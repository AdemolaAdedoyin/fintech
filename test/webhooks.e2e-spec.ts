import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OutboxEventType } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/auth.constants';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookCryptoService } from '../src/webhooks/webhook-crypto.service';
import {
  WebhookDeliveryService,
  type WebhookJobData,
} from '../src/webhooks/webhook-delivery.service';
import {
  WebhookTransportError,
  WebhookTransportService,
} from '../src/webhooks/webhook-transport.service';
import { WebhookWorkerService } from '../src/webhooks/webhook-worker.service';
import { WebhooksService } from '../src/webhooks/webhooks.service';

interface SubscriptionBody {
  id: string;
  secret: string;
  url: string;
}
interface HistoryBody {
  items: { id: string; attempts: unknown[] }[];
  nextCursor: string | null;
}

describe('Outbound webhooks (PostgreSQL/Redis e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let deliveries: WebhookDeliveryService;
  let webhooks: WebhooksService;
  let crypto: WebhookCryptoService;
  let config: ConfigService;
  let userId: string;
  let token: string;
  const transport = {
    validate: jest.fn<Promise<void>, [string]>(),
    send: jest.fn<Promise<number>, [string, string, Record<string, string>]>(),
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = 'webhook-e2e-jwt-secret-longer-than-thirty-two-characters';
    process.env.WEBHOOK_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.LOG_LEVEL = 'silent';
    process.env.OUTBOX_POLL_INTERVAL_MS = '60000';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WebhookTransportService)
      .useValue(transport)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    deliveries = app.get(WebhookDeliveryService);
    webhooks = app.get(WebhooksService);
    crypto = app.get(WebhookCryptoService);
    config = app.get(ConfigService);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    transport.validate.mockResolvedValue(undefined);
    transport.send.mockResolvedValue(204);
    const user = await prisma.user.create({
      data: {
        email: `webhook-${randomUUID()}@example.com`,
        passwordHash: 'unused',
        firstName: 'Webhook',
        lastName: 'Test',
      },
    });
    userId = user.id;
    token = app.get(JwtService).sign(
      { sub: userId, email: user.email, type: 'access' },
      {
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: 900,
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      },
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Cancel only this test's subscriptions. Never clear shared delivery tables or Redis.
    const subscriptions = await prisma.webhookSubscription.findMany({ where: { userId } });
    for (const subscription of subscriptions) await webhooks.disable(userId, subscription.id);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function subscribe(): Promise<SubscriptionBody> {
    const response = await request(server)
      .post('/api/v1/webhooks')
      .auth(token, { type: 'bearer' })
      .send({ url: 'https://merchant.example.com/events' })
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    return response.body as SubscriptionBody;
  }
  function event(type: OutboxEventType = 'TRANSFER_COMPLETED') {
    return prisma.outboxEvent.create({
      data: {
        type,
        actorUserId: userId,
        aggregateId: randomUUID(),
        aggregateType: 'Transfer',
        payload: { amountMinor: '100', currency: 'USD' },
      },
    });
  }
  async function claim(id: string): Promise<WebhookJobData> {
    const jobs = await deliveries.claimBatch();
    const job = jobs.find((item) => item.deliveryId === id);
    if (!job) throw new Error('Expected delivery was not claimed');
    return job;
  }
  async function fixture(type: OutboxEventType = 'TRANSFER_COMPLETED') {
    const subscription = await subscribe();
    const outbox = await event(type);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { outboxEventId: outbox.id, subscriptionId: subscription.id },
    });
    return { subscription, outbox, delivery };
  }
  function read(id: string) {
    return prisma.webhookDelivery.findUniqueOrThrow({
      where: { id },
      include: { attempts: { orderBy: { number: 'asc' } } },
    });
  }
  async function due(id: string) {
    await prisma.webhookDelivery.update({ where: { id }, data: { availableAt: new Date(0) } });
  }
  async function expire(id: string) {
    await prisma.webhookDelivery.update({ where: { id }, data: { leaseUntil: new Date(0) } });
  }

  it.each<OutboxEventType>(['TRANSFER_COMPLETED', 'TRANSFER_REVERSED'])(
    'signs %s and fences concurrent/duplicate jobs',
    async (type) => {
      const { subscription, delivery, outbox } = await fixture(type);
      const job = await claim(delivery.id);
      await Promise.all([deliveries.execute(job), deliveries.execute(job)]);
      await deliveries.execute(job);
      expect(transport.send).toHaveBeenCalledTimes(1);
      const [, body, headers] = transport.send.mock.calls[0];
      expect(JSON.parse(body) as unknown).toEqual({
        id: outbox.id,
        deliveryId: delivery.id,
        type,
        createdAt: outbox.createdAt.toISOString(),
        data: { amountMinor: '100', currency: 'USD' },
      });
      expect(headers['Webhook-Signature']).toBe(
        `v1=${createHmac('sha256', subscription.secret).update(`${headers['Webhook-Timestamp']}.${body}`).digest('hex')}`,
      );
      expect(headers['Webhook-Id']).toBe(delivery.id);
      expect(await read(delivery.id)).toMatchObject({
        status: 'DELIVERED',
        attemptCount: 1,
        leaseToken: null,
        attempts: [{ status: 'SUCCEEDED', httpStatus: 204 }],
      });
    },
  );

  it('protects ownership, UUID validation, pagination and secrets', async () => {
    const { subscription, delivery } = await fixture();
    await event();
    const list = await request(server)
      .get('/api/v1/webhooks')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/secret|encryptedSecret|leaseToken/i);
    const stored = await prisma.webhookSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(stored.encryptedSecret).not.toContain(subscription.secret);
    const page = await request(server)
      .get(`/api/v1/webhooks/${subscription.id}/deliveries?limit=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const first = page.body as HistoryBody;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await request(server)
      .get(`/api/v1/webhooks/${subscription.id}/deliveries?limit=1&cursor=${first.nextCursor}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect((second.body as HistoryBody).items[0].id).not.toBe(first.items[0].id);
    expect(JSON.stringify(page.body)).not.toMatch(/secret|leaseToken/i);
    const other = await subscribe();
    await request(server)
      .get(`/api/v1/webhooks/${other.id}/deliveries?cursor=${delivery.id}`)
      .auth(token, { type: 'bearer' })
      .expect(400);
    const otherUser = await prisma.user.create({
      data: {
        email: `stranger-${randomUUID()}@example.com`,
        passwordHash: 'unused',
        firstName: 'Other',
        lastName: 'User',
      },
    });
    const stranger = app.get(JwtService).sign(
      { sub: otherUser.id, email: otherUser.email, type: 'access' },
      {
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      },
    );
    await request(server)
      .get(`/api/v1/webhooks/${subscription.id}/deliveries`)
      .auth(stranger, { type: 'bearer' })
      .expect(404);
    await request(server)
      .delete(`/api/v1/webhooks/${subscription.id}`)
      .auth(stranger, { type: 'bearer' })
      .expect(404);
    await request(server).get('/api/v1/webhooks').expect(401);
    await request(server).post('/api/v1/webhooks').send({ url: 'https://example.com' }).expect(401);
    await request(server)
      .delete('/api/v1/webhooks/not-a-uuid')
      .auth(token, { type: 'bearer' })
      .expect(400);
    transport.validate.mockRejectedValueOnce(new WebhookTransportError('UNSAFE_ENDPOINT'));
    await request(server)
      .post('/api/v1/webhooks')
      .auth(token, { type: 'bearer' })
      .send({ url: 'http://localhost' })
      .expect(400);
    jest.spyOn(crypto, 'enabled', 'get').mockReturnValueOnce(false);
    await request(server)
      .post('/api/v1/webhooks')
      .auth(token, { type: 'bearer' })
      .send({ url: 'https://example.com' })
      .expect(503);
  });

  it('fans out transactionally without historical or disabled subscriptions', async () => {
    const old = await event();
    const subscription = await subscribe();
    expect(await prisma.webhookDelivery.count({ where: { outboxEventId: old.id } })).toBe(0);
    let rolledBackId = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const inserted = await tx.outboxEvent.create({
          data: {
            type: 'TRANSFER_COMPLETED',
            actorUserId: userId,
            aggregateId: randomUUID(),
            aggregateType: 'Transfer',
            payload: {},
          },
        });
        rolledBackId = inserted.id;
        expect(await tx.webhookDelivery.count({ where: { outboxEventId: inserted.id } })).toBe(1);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.webhookDelivery.count({ where: { outboxEventId: rolledBackId } })).toBe(0);
    await webhooks.disable(userId, subscription.id);
    const disabled = await event();
    expect(await prisma.webhookDelivery.count({ where: { outboxEventId: disabled.id } })).toBe(0);
  });

  it('does not include an uncommitted concurrent subscription in event fan-out', async () => {
    let inserted!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creating = prisma.$transaction(async (tx) => {
      await tx.webhookSubscription.create({
        data: { userId, url: 'https://example.com', encryptedSecret: crypto.encrypt('secret') },
      });
      inserted();
      await gate;
    });
    await ready;
    try {
      const outbox = await event();
      expect(await prisma.webhookDelivery.count({ where: { outboxEventId: outbox.id } })).toBe(0);
    } finally {
      release();
      await creating;
    }
    const next = await event();
    expect(await prisma.webhookDelivery.count({ where: { outboxEventId: next.id } })).toBe(1);
  });

  it.each([408, 429, 503])('retries HTTP %i, then succeeds', async (status) => {
    const { delivery } = await fixture();
    transport.send.mockResolvedValueOnce(status);
    await deliveries.execute(await claim(delivery.id));
    const pending = await read(delivery.id);
    expect(pending.status).toBe('PENDING');
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now());
    await due(delivery.id);
    await deliveries.execute(await claim(delivery.id));
    expect(await read(delivery.id)).toMatchObject({ status: 'DELIVERED', attemptCount: 2 });
  });

  it.each([400, 301, 403])('does not retry HTTP %i', async (status) => {
    const { delivery } = await fixture();
    transport.send.mockResolvedValueOnce(status);
    await deliveries.execute(await claim(delivery.id));
    expect(await read(delivery.id)).toMatchObject({ status: 'FAILED', attemptCount: 1 });
  });

  it('bounds timeout retries to five total attempts with four delays', async () => {
    const { delivery } = await fixture();
    transport.send.mockRejectedValue(new WebhookTransportError('TIMEOUT'));
    for (let n = 1; n <= 5; n++) {
      const start = Date.now();
      await deliveries.execute(await claim(delivery.id));
      const row = await read(delivery.id);
      expect(row.attemptCount).toBe(n);
      expect(row.status).toBe(n === 5 ? 'FAILED' : 'PENDING');
      if (n < 5) {
        expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(start + 1000 * 2 ** (n - 1));
        await due(delivery.id);
      }
    }
    expect(await deliveries.claimBatch()).toEqual([]);
    expect(transport.send).toHaveBeenCalledTimes(5);
  });

  it('recovers expired leases and ignores stale jobs', async () => {
    const { delivery } = await fixture();
    const old = await claim(delivery.id);
    await expire(delivery.id);
    const current = await claim(delivery.id);
    await deliveries.execute(old);
    expect(transport.send).not.toHaveBeenCalled();
    await deliveries.execute(current);
    await deliveries.publicationFailed(old);
    expect(await read(delivery.id)).toMatchObject({
      status: 'DELIVERED',
      attempts: [{ status: 'ABANDONED' }, { status: 'SUCCEEDED' }],
    });
  });

  it('rechecks lease expiry after waiting for a database row lock', async () => {
    const { delivery } = await fixture();
    const job = await claim(delivery.id);
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { leaseUntil: new Date(Date.now() + 500) },
    });
    const holding = prisma.$transaction(async (tx) => {
      // Hold the row unchanged: expiry must be checked after the lock wait even
      // when PostgreSQL has no updated tuple that would rerun the predicate.
      await tx.$queryRaw`SELECT "id" FROM "WebhookDelivery" WHERE "id" = ${delivery.id}::uuid FOR UPDATE`;
      locked();
      await gate;
    });
    await ready;
    const executing = deliveries.execute(job);
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    await holding;
    await executing;
    expect(transport.send).not.toHaveBeenCalled();
    expect((await read(delivery.id)).attempts[0].status).toBe('QUEUED');
  });

  it('stops recovering expired claims at the attempt limit', async () => {
    const { delivery } = await fixture();
    for (let n = 0; n < 5; n++) {
      await claim(delivery.id);
      await expire(delivery.id);
    }
    expect(await deliveries.claimBatch()).toEqual([]);
    expect(await read(delivery.id)).toMatchObject({ status: 'FAILED', attemptCount: 5 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('bounds queue publication failures and never executes released jobs', async () => {
    const { delivery } = await fixture();
    for (let n = 0; n < 5; n++) {
      const job = await claim(delivery.id);
      await deliveries.publicationFailed(job);
      await deliveries.execute(job);
      if (n < 4) await due(delivery.id);
    }
    expect(await read(delivery.id)).toMatchObject({ status: 'FAILED', attemptCount: 5 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('cancels a claimed delivery when its subscription is disabled', async () => {
    const { subscription, delivery } = await fixture();
    const job = await claim(delivery.id);
    await request(server)
      .delete(`/api/v1/webhooks/${subscription.id}`)
      .auth(token, { type: 'bearer' })
      .expect(204);
    await deliveries.execute(job);
    expect(transport.send).not.toHaveBeenCalled();
    expect(await read(delivery.id)).toMatchObject({
      status: 'CANCELLED',
      leaseToken: null,
      attempts: [{ status: 'CANCELLED' }],
    });
  });

  it('does not let an ambiguous queue error or disable race overwrite an in-flight attempt', async () => {
    const { subscription, delivery } = await fixture();
    let finish!: (status: number) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.send.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const job = await claim(delivery.id);
    const execution = deliveries.execute(job);
    await ready;
    try {
      await deliveries.publicationFailed(job);
      expect((await read(delivery.id)).status).toBe('PROCESSING');
      await webhooks.disable(userId, subscription.id);
    } finally {
      finish(204);
      await execution;
    }
    expect((await read(delivery.id)).status).toBe('CANCELLED');
  });

  it('does not allow a stale in-flight result to overwrite the replacement lease', async () => {
    const { delivery } = await fixture();
    let finish!: (status: number) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.send.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const old = await claim(delivery.id);
    const execution = deliveries.execute(old);
    await ready;
    await expire(delivery.id);
    const replacement = await claim(delivery.id);
    finish(204);
    await execution;
    expect(await read(delivery.id)).toMatchObject({
      status: 'PROCESSING',
      leaseToken: replacement.leaseToken,
    });
    await deliveries.execute(replacement);
    expect((await read(delivery.id)).status).toBe('DELIVERED');
  });

  it('keeps HTTP success unknown if database persistence fails, then recovers by lease', async () => {
    const { delivery } = await fixture();
    transport.send.mockImplementationOnce(() => {
      jest
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('simulated persistence outage'));
      return Promise.resolve(204);
    });
    await expect(deliveries.execute(await claim(delivery.id))).rejects.toThrow(
      'simulated persistence outage',
    );
    expect(await read(delivery.id)).toMatchObject({
      status: 'PROCESSING',
      attempts: [{ status: 'SENDING' }],
    });
    jest.restoreAllMocks();
    await expire(delivery.id);
    await deliveries.execute(await claim(delivery.id));
    expect(await read(delivery.id)).toMatchObject({ status: 'DELIVERED', attemptCount: 2 });
  });

  it('treats unsafe endpoints and undecryptable secrets as terminal failures', async () => {
    const first = await fixture();
    transport.send.mockRejectedValueOnce(new WebhookTransportError('UNSAFE_ENDPOINT'));
    await deliveries.execute(await claim(first.delivery.id));
    expect((await read(first.delivery.id)).status).toBe('FAILED');
    await webhooks.disable(userId, first.subscription.id);
    const second = await fixture();
    await prisma.webhookSubscription.update({
      where: { id: second.subscription.id },
      data: { encryptedSecret: 'corrupt' },
    });
    await deliveries.execute(await claim(second.delivery.id));
    expect(await read(second.delivery.id)).toMatchObject({
      status: 'FAILED',
      attempts: [{ errorCode: 'SIGNING_UNAVAILABLE' }],
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('enforces migration checks and one delivery per event/subscription', async () => {
    const { delivery } = await fixture();
    await expect(
      prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attemptCount: 6 } }),
    ).rejects.toThrow();
    await expect(
      prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'PROCESSING' } }),
    ).rejects.toThrow();
    await expect(
      prisma.webhookAttempt.create({ data: { deliveryId: delivery.id, number: 6 } }),
    ).rejects.toThrow();
    await expect(
      prisma.webhookDelivery.create({
        data: { subscriptionId: delivery.subscriptionId, outboxEventId: delivery.outboxEventId },
      }),
    ).rejects.toThrow();
  });

  it('claims deliveries exclusively under concurrent workers', async () => {
    const { delivery } = await fixture();
    const batches = await Promise.all([deliveries.claimBatch(), deliveries.claimBatch()]);
    expect(batches.flat().filter((job) => job.deliveryId === delivery.id)).toHaveLength(1);
  });

  it('dispatches through real Redis/BullMQ and shuts down cleanly', async () => {
    const { delivery } = await fixture();
    const worker = new WebhookWorkerService(config, crypto, deliveries);
    try {
      await worker.onModuleInit();
      for (let i = 0; i < 60; i++) {
        await worker.dispatchOnce();
        if ((await read(delivery.id)).status === 'DELIVERED') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await read(delivery.id)).status).toBe('DELIVERED');
      expect(transport.send).toHaveBeenCalledTimes(1);
      let release!: (jobs: WebhookJobData[]) => void;
      const claimGate = new Promise<WebhookJobData[]>((resolve) => {
        release = resolve;
      });
      jest.spyOn(deliveries, 'claimBatch').mockReturnValueOnce(claimGate);
      const dispatch = worker.dispatchOnce();
      let stopped = false;
      const shutdown = worker.onModuleDestroy().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      release([]);
      await Promise.all([dispatch, shutdown]);
      expect(stopped).toBe(true);
    } finally {
      await worker.onModuleDestroy();
    }
  });
});
