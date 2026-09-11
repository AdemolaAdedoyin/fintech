import { IdempotencyStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Idempotency integrity (e2e)', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('makes terminal idempotency records immutable', async () => {
    const user = await prisma.user.create({
      data: {
        email: `idempotency-${randomUUID()}@example.com`,
        passwordHash: 'not-used-by-this-integrity-test',
        firstName: 'Idempotency',
        lastName: 'Integrity',
      },
    });

    await expect(
      prisma.idempotencyRecord.create({
        data: {
          userId: user.id,
          scope: 'internal-transfer',
          key: `terminal-${randomUUID()}`,
          requestHash: 'a'.repeat(64),
          status: IdempotencyStatus.FAILED,
          responseStatus: 409,
          errorMessage: 'forged terminal result',
        },
      }),
    ).rejects.toThrow();

    const claim = await prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        scope: 'internal-transfer',
        key: `claim-${randomUUID()}`,
        requestHash: 'b'.repeat(64),
      },
    });

    await expect(
      prisma.idempotencyRecord.update({
        where: { id: claim.id },
        data: { requestHash: 'c'.repeat(64) },
      }),
    ).rejects.toThrow();

    const terminal = await prisma.idempotencyRecord.update({
      where: { id: claim.id },
      data: {
        status: IdempotencyStatus.FAILED,
        responseStatus: 409,
        errorMessage: 'stored transfer failure',
      },
    });
    expect(terminal.status).toBe(IdempotencyStatus.FAILED);

    await expect(
      prisma.idempotencyRecord.update({
        where: { id: claim.id },
        data: { errorMessage: 'rewritten failure' },
      }),
    ).rejects.toThrow();

    await expect(prisma.idempotencyRecord.delete({ where: { id: claim.id } })).rejects.toThrow();
  });
});
