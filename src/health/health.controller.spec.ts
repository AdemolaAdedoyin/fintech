import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { OperationalRedis } from '../operations/redis.service';
const redis = {
  client: { ping: jest.fn().mockResolvedValue('PONG') },
} as unknown as OperationalRedis;
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  it('reports process liveness', () => {
    const prisma = { $queryRaw: jest.fn() } as unknown as PrismaService;
    const controller = new HealthController(prisma, redis);

    expect(controller.liveness()).toEqual(
      expect.objectContaining({
        status: 'ok',
        service: 'fintech-transaction-platform',
      }),
    );
  });

  it('reports database readiness when PostgreSQL responds', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ result: 1 }]),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma, redis);

    await expect(controller.readiness()).resolves.toEqual(
      expect.objectContaining({ status: 'ok', database: 'up' }),
    );
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as PrismaService;
    const controller = new HealthController(prisma, redis);

    await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
