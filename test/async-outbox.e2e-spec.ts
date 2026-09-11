import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, OutboxEventType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AsyncRuntimeService } from '../src/async/async-runtime.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

interface WalletBody {
  id: string;
  currency: Currency;
}

interface AuthBody {
  accessToken: string;
  user: { id: string };
  initialWallet: WalletBody;
}

interface TransferBody {
  id: string;
  reference: string;
  amountMinor: string;
}

interface NotificationBody {
  id: string;
  eventType: OutboxEventType;
  readAt: string | null;
}

describe('Transactional outbox and async delivery (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let runtime: AsyncRuntimeService;

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = (label: string) => `${label}-${runId}-${randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5433/fintech?schema=public';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET =
      'phase-six-async-secret-that-is-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
    process.env.WEBHOOK_SIGNING_MASTER_SECRET =
      'phase-six-webhook-signing-master-secret-that-is-long-enough';
    process.env.WEBHOOK_REQUEST_TIMEOUT_MS = '1000';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    httpServer = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
    runtime = app.get(AsyncRuntimeService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(label: string): Promise<AuthBody> {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        password: 'correct-horse-battery-staple',
        firstName: 'Phase',
        lastName: 'Six',
        currency: Currency.USD,
      })
      .expect(HttpStatus.CREATED);

    return response.body as AuthBody;
  }

  async function fund(walletId: string, amountMinor: bigint): Promise<void> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
      select: { ledgerAccountId: true, currency: true },
    });
    const clearing = await ledger.getExternalClearingAccount(wallet.currency);

    await ledger.post({
      reference: `phase6:fund:${randomUUID()}`,
      currency: wallet.currency,
      description: 'Phase 6 async test funding',
      postings: [
        { accountId: clearing.id, amountMinor: -amountMinor },
        { accountId: wallet.ledgerAccountId, amountMinor },
      ],
    });
  }

  async function waitForNotifications(outboxEventId: string, expected: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const notifications = await prisma.notification.findMany({
        where: { outboxEventId },
        orderBy: { createdAt: 'asc' },
      });
      if (notifications.length === expected) return notifications;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for ${expected} notifications for ${outboxEventId}`);
  }

  it('commits one outbox event with the transfer and processes it idempotently', async () => {
    const sender = await register('async-sender');
    const recipient = await register('async-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const idempotencyKey = `phase6-transfer-${randomUUID()}`;
    const transferResponse = await request(httpServer)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId: recipient.initialWallet.id,
        amountMinor: '2500',
      })
      .expect(HttpStatus.CREATED);

    const transfer = transferResponse.body as TransferBody;
    const outbox = await prisma.outboxEvent.findUniqueOrThrow({
      where: { transferId: transfer.id },
    });

    expect(outbox.eventType).toBe(OutboxEventType.TRANSFER_COMPLETED);
    expect(outbox.payload).toMatchObject({
      senderUserId: sender.user.id,
      recipientUserId: recipient.user.id,
      transferId: transfer.id,
      reference: transfer.reference,
      amountMinor: '2500',
      currency: Currency.USD,
    });

    await runtime.dispatchOutbox();
    const notifications = await waitForNotifications(outbox.id, 2);
    expect(new Set(notifications.map((item) => item.userId))).toEqual(
      new Set([sender.user.id, recipient.user.id]),
    );

    const replayResponse = await request(httpServer)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId: recipient.initialWallet.id,
        amountMinor: '2500',
      })
      .expect(HttpStatus.CREATED);

    expect((replayResponse.body as TransferBody).id).toBe(transfer.id);
    expect(await prisma.outboxEvent.count({ where: { transferId: transfer.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { outboxEventId: outbox.id } })).toBe(2);

    const notificationResponse = await request(httpServer)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.OK);
    const owned = notificationResponse.body as NotificationBody[];
    const senderNotification = owned.find((item) => item.eventType === outbox.eventType);
    expect(senderNotification).toBeDefined();

    await request(httpServer)
      .post(`/api/v1/notifications/${senderNotification!.id}/read`)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.CREATED)
      .expect((response) => {
        expect((response.body as NotificationBody).readAt).not.toBeNull();
      });
  });

  it('does not create an outbox event when the financial transaction fails', async () => {
    const sender = await register('failed-sender');
    const recipient = await register('failed-recipient');
    const before = await prisma.outboxEvent.count();

    await request(httpServer)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .set('Idempotency-Key', `phase6-insufficient-${randomUUID()}`)
      .send({
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId: recipient.initialWallet.id,
        amountMinor: '8000',
      })
      .expect(HttpStatus.CONFLICT);

    expect(await prisma.outboxEvent.count()).toBe(before);
  });

  it('rejects direct outbox creation outside the guarded write path', async () => {
    await expect(
      prisma.outboxEvent.create({
        data: {
          eventType: OutboxEventType.TRANSFER_COMPLETED,
          transferId: randomUUID(),
          payload: {
            senderUserId: randomUUID(),
            recipientUserId: randomUUID(),
            transferId: randomUUID(),
            reference: `forged:${randomUUID()}`,
            amountMinor: '1',
            currency: Currency.USD,
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('manages webhook endpoints without exposing the signing secret after creation', async () => {
    const user = await register('webhook-owner');

    await request(httpServer)
      .post('/api/v1/webhooks/endpoints')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ url: 'https://127.0.0.1/hook' })
      .expect(HttpStatus.BAD_REQUEST);

    const createResponse = await request(httpServer)
      .post('/api/v1/webhooks/endpoints')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        url: `https://example.com/hooks/${runId}`,
        description: 'Phase 6 test endpoint',
      })
      .expect(HttpStatus.CREATED);

    expect(createResponse.body.signingSecret).toEqual(expect.any(String));
    const endpointId = createResponse.body.id as string;

    const listResponse = await request(httpServer)
      .get('/api/v1/webhooks/endpoints')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(HttpStatus.OK);
    expect(listResponse.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: endpointId, enabled: true })]),
    );
    expect(listResponse.body[0]).not.toHaveProperty('signingSecret');

    await request(httpServer)
      .delete(`/api/v1/webhooks/endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(HttpStatus.OK)
      .expect((response) => {
        expect(response.body.enabled).toBe(false);
      });
  });
});
