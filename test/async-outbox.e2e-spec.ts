import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxEventType, OutboxStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AsyncWorkerModule } from '../src/async/async-worker.module';
import { AsyncWorkerService } from '../src/async/async-worker.service';
import { NotificationService } from '../src/async/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Transactional outbox notification worker (e2e)', () => {
  let app: INestApplicationContext;
  let prisma: PrismaService;
  let worker: AsyncWorkerService;
  let notifications: NotificationService;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5433/fintech?schema=public';
    process.env.REDIS_URL ??= 'redis://localhost:6380';
    process.env.JWT_ACCESS_SECRET =
      'phase-six-worker-secret-that-is-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';
    process.env.OUTBOX_POLL_INTERVAL_MS = '60000';

    app = await NestFactory.createApplicationContext(AsyncWorkerModule, { logger: false });
    prisma = app.get(PrismaService);
    worker = app.get(AsyncWorkerService);
    notifications = app.get(NotificationService);
  });

  afterAll(async () => app.close());

  it('publishes a claimed event and persists one notification across duplicate delivery', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `outbox-${suffix}@example.com`,
        passwordHash: 'not-used-by-this-test',
        firstName: 'Phase',
        lastName: 'Six',
      },
    });
    const event = await prisma.outboxEvent.create({
      data: {
        type: OutboxEventType.TRANSFER_COMPLETED,
        aggregateType: 'Transfer',
        aggregateId: randomUUID(),
        actorUserId: user.id,
        payload: { transferId: randomUUID(), amountMinor: '2500', currency: 'USD' },
      },
    });

    await worker.dispatchOnce();

    let notification = await prisma.notification.findUnique({
      where: { outboxEventId: event.id },
    });
    for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      notification = await prisma.notification.findUnique({
        where: { outboxEventId: event.id },
      });
    }

    expect(notification).not.toBeNull();
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      OutboxStatus.PUBLISHED,
    );

    await notifications.persistForEvent(event.id);
    await notifications.persistForEvent(event.id);
    expect(await prisma.notification.count({ where: { outboxEventId: event.id } })).toBe(1);
  });
});
