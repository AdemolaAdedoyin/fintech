import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, Currency, IdempotencyStatus, Prisma, TransferStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

interface WalletBody {
  id: string;
  currency: Currency;
  currentBalanceMinor: string;
}

interface AuthBody {
  accessToken: string;
  user: { id: string };
  initialWallet: WalletBody;
}

interface TransferBody {
  id: string;
  ledgerTransactionId: string;
  sourceWalletId: string;
  destinationWalletId: string;
  currency: Currency;
  amountMinor: string;
  status: TransferStatus;
}

interface ReversalBody {
  id: string;
  reference: string;
  transferId: string;
  ledgerTransactionId: string;
  currency: Currency;
  amountMinor: string;
  reason: string | null;
}

interface AuditBody {
  id: string;
  action: AuditAction;
  transferId: string;
  reversalId: string | null;
}

describe('Transfer reversals and audit history (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;
  let prisma: PrismaService;
  let ledger: LedgerService;

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = (label: string) =>
    `${label.slice(0, 12)}-${runId}-${randomUUID().slice(0, 8)}@example.com`;
  const reference = (label: string) => `${runId}:${label}:${randomUUID()}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5433/fintech?schema=public';
    process.env.JWT_ACCESS_SECRET =
      'phase-five-reversal-secret-that-is-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
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
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(label: string) {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        password: 'correct-horse-battery-staple',
        firstName: 'Phase',
        lastName: 'Five',
        currency: Currency.USD,
      })
      .expect(HttpStatus.CREATED);

    return response.body as AuthBody;
  }

  async function fund(walletId: string, amountMinor: bigint) {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
      select: { ledgerAccountId: true, currency: true },
    });
    const clearing = await ledger.getExternalClearingAccount(wallet.currency);

    await ledger.post({
      reference: reference('fund'),
      currency: wallet.currency,
      description: 'Phase 5 reversal test funding',
      postings: [
        { accountId: clearing.id, amountMinor: -amountMinor },
        { accountId: wallet.ledgerAccountId, amountMinor },
      ],
    });
  }

  async function transfer(
    sender: AuthBody,
    destinationWalletId: string,
    amountMinor: string,
    key: string,
  ) {
    const response = await request(httpServer)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .set('Idempotency-Key', key)
      .send({
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId,
        amountMinor,
      })
      .expect(HttpStatus.CREATED);

    return response.body as TransferBody;
  }

  function reverse(
    token: string,
    transferId: string,
    key: string,
    body: Record<string, unknown> = {},
  ) {
    return request(httpServer)
      .post(`/api/v1/transfers/${transferId}/reversal`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  it('creates an exact compensating ledger transaction and immutable audit history', async () => {
    const sender = await register('reverse-sender');
    const recipient = await register('reverse-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const original = await transfer(
      sender,
      recipient.initialWallet.id,
      '4000',
      `${runId}-reverse-transfer`,
    );

    const first = await reverse(sender.accessToken, original.id, `${runId}-reverse-request`, {
      reason: 'Duplicate payment',
    }).expect(HttpStatus.CREATED);
    const reversal = first.body as ReversalBody;

    expect(reversal.transferId).toBe(original.id);
    expect(reversal.amountMinor).toBe('4000');
    expect(reversal.reason).toBe('Duplicate payment');
    expect(reversal.ledgerTransactionId).not.toBe(original.ledgerTransactionId);

    const [sourceWallet, destinationWallet, storedOriginal, storedReversal] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: sender.initialWallet.id } }),
      prisma.wallet.findUniqueOrThrow({ where: { id: recipient.initialWallet.id } }),
      prisma.transfer.findUniqueOrThrow({ where: { id: original.id } }),
      prisma.transferReversal.findUniqueOrThrow({
        where: { id: reversal.id },
        include: { ledgerTransaction: { include: { postings: true } } },
      }),
    ]);

    expect(sourceWallet.currentBalanceMinor).toBe(10_000n);
    expect(destinationWallet.currentBalanceMinor).toBe(0n);
    expect(storedOriginal.status).toBe(TransferStatus.COMPLETED);
    expect(storedReversal.ledgerTransaction.sealedAt).toBeInstanceOf(Date);
    expect(storedReversal.ledgerTransaction.postings).toHaveLength(2);

    const sourceAccount = await prisma.wallet.findUniqueOrThrow({
      where: { id: sender.initialWallet.id },
      select: { ledgerAccountId: true },
    });
    const destinationAccount = await prisma.wallet.findUniqueOrThrow({
      where: { id: recipient.initialWallet.id },
      select: { ledgerAccountId: true },
    });
    const postingByAccount = new Map(
      storedReversal.ledgerTransaction.postings.map((posting) => [
        posting.accountId,
        posting.amountMinor,
      ]),
    );
    expect(postingByAccount.get(sourceAccount.ledgerAccountId)).toBe(4_000n);
    expect(postingByAccount.get(destinationAccount.ledgerAccountId)).toBe(-4_000n);

    const replay = await reverse(sender.accessToken, original.id, `${runId}-reverse-request`, {
      reason: 'Duplicate payment',
    }).expect(HttpStatus.CREATED);
    expect((replay.body as ReversalBody).id).toBe(reversal.id);

    await reverse(sender.accessToken, original.id, `${runId}-reverse-request`, {
      reason: 'Different reason',
    }).expect(HttpStatus.CONFLICT);

    const auditResponse = await request(httpServer)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.OK);
    const relatedAudit = (auditResponse.body as AuditBody[]).filter(
      (entry) => entry.transferId === original.id,
    );
    expect(relatedAudit).toHaveLength(2);
    expect(relatedAudit.map((entry) => entry.action).sort()).toEqual(
      [AuditAction.TRANSFER_CREATED, AuditAction.TRANSFER_REVERSED].sort(),
    );
    expect(
      relatedAudit.find((entry) => entry.action === AuditAction.TRANSFER_REVERSED)?.reversalId,
    ).toBe(reversal.id);

    const lookup = await request(httpServer)
      .get(`/api/v1/transfers/${original.id}/reversal`)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.OK);
    expect((lookup.body as ReversalBody).id).toBe(reversal.id);

    await request(httpServer)
      .get(`/api/v1/transfers/${original.id}/reversal`)
      .set('Authorization', `Bearer ${recipient.accessToken}`)
      .expect(HttpStatus.NOT_FOUND);

    expect(await prisma.transferReversal.count({ where: { transferId: original.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { transferId: original.id, action: AuditAction.TRANSFER_REVERSED },
      }),
    ).toBe(1);
  });

  it('persists a failed reversal so later funds cannot change the same request outcome', async () => {
    const sender = await register('failed-sender');
    const recipient = await register('failed-recipient');
    const thirdParty = await register('failed-third');
    await fund(sender.initialWallet.id, 10_000n);

    const original = await transfer(
      sender,
      recipient.initialWallet.id,
      '8000',
      `${runId}-failed-original`,
    );
    await transfer(recipient, thirdParty.initialWallet.id, '8000', `${runId}-spend-recipient`);

    const key = `${runId}-failed-reversal`;
    await reverse(sender.accessToken, original.id, key, { reason: 'Recall' }).expect(
      HttpStatus.CONFLICT,
    );

    await fund(recipient.initialWallet.id, 8_000n);
    await reverse(sender.accessToken, original.id, key, { reason: 'Recall' }).expect(
      HttpStatus.CONFLICT,
    );

    expect(await prisma.transferReversal.count({ where: { transferId: original.id } })).toBe(0);
    const stored = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        userId_scope_key: {
          userId: sender.user.id,
          scope: 'transfer-reversal',
          key,
        },
      },
    });
    expect(stored.status).toBe(IdempotencyStatus.FAILED);
    expect(stored.responseStatus).toBe(HttpStatus.CONFLICT);
  });

  it('serializes competing reversal requests so an original transfer is compensated once', async () => {
    const sender = await register('race-sender');
    const recipient = await register('race-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const original = await transfer(
      sender,
      recipient.initialWallet.id,
      '8000',
      `${runId}-race-original`,
    );

    const [responseA, responseB] = await Promise.all([
      reverse(sender.accessToken, original.id, `${runId}-race-a`, { reason: 'Race' }),
      reverse(sender.accessToken, original.id, `${runId}-race-b`, { reason: 'Race' }),
    ]);

    expect([responseA.status, responseB.status].sort((a, b) => a - b)).toEqual([
      HttpStatus.CREATED,
      HttpStatus.CONFLICT,
    ]);
    expect(await prisma.transferReversal.count({ where: { transferId: original.id } })).toBe(1);

    const [sourceWallet, destinationWallet] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: sender.initialWallet.id } }),
      prisma.wallet.findUniqueOrThrow({ where: { id: recipient.initialWallet.id } }),
    ]);
    expect(sourceWallet.currentBalanceMinor).toBe(10_000n);
    expect(destinationWallet.currentBalanceMinor).toBe(0n);
  });

  it('enforces reversal ownership and keeps direct reversal and audit history immutable', async () => {
    const sender = await register('guard-sender');
    const recipient = await register('guard-recipient');
    await fund(sender.initialWallet.id, 5_000n);

    const original = await transfer(
      sender,
      recipient.initialWallet.id,
      '2000',
      `${runId}-guard-original`,
    );

    await reverse(recipient.accessToken, original.id, `${runId}-unauthorized`, {
      reason: 'Not mine',
    }).expect(HttpStatus.NOT_FOUND);

    const originalStored = await prisma.transfer.findUniqueOrThrow({ where: { id: original.id } });
    await expect(
      prisma.transferReversal.create({
        data: {
          reference: reference('direct-reversal'),
          transferId: original.id,
          actorUserId: sender.user.id,
          ledgerTransactionId: originalStored.ledgerTransactionId,
          currency: originalStored.currency,
          amountMinor: originalStored.amountMinor,
        },
      }),
    ).rejects.toThrow();

    const legitimate = await reverse(sender.accessToken, original.id, `${runId}-guard-legitimate`, {
      reason: 'Guard test',
    }).expect(HttpStatus.CREATED);
    const reversal = legitimate.body as ReversalBody;

    await expect(
      prisma.transferReversal.update({
        where: { id: reversal.id },
        data: { reason: 'Rewritten' },
      }),
    ).rejects.toThrow();
    await expect(prisma.transferReversal.delete({ where: { id: reversal.id } })).rejects.toThrow();

    const audit = await prisma.auditLog.findUniqueOrThrow({
      where: { reversalId: reversal.id },
    });
    await expect(
      prisma.auditLog.update({ where: { id: audit.id }, data: { createdAt: new Date() } }),
    ).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow();
  });

  it('rejects a forged reversal at the deferred database integrity boundary without partial state', async () => {
    const sender = await register('forged-sender');
    const recipient = await register('forged-recipient');
    await fund(sender.initialWallet.id, 5_000n);

    const original = await transfer(
      sender,
      recipient.initialWallet.id,
      '2000',
      `${runId}-forged-original`,
    );
    const transferRow = await prisma.transfer.findUniqueOrThrow({
      where: { id: original.id },
      include: {
        sourceWallet: { select: { ledgerAccountId: true } },
        destinationWallet: { select: { ledgerAccountId: true } },
      },
    });
    const reversalId = randomUUID();
    const forgedReference = `reversal:${reversalId}`;

    await expect(
      prisma.$transaction(
        async (transaction) => {
          const forgedLedger = await ledger.postWithinTransaction(transaction, {
            reference: forgedReference,
            currency: transferRow.currency,
            description: 'Forged partial reversal',
            postings: [
              { accountId: transferRow.sourceWallet.ledgerAccountId, amountMinor: 500n },
              { accountId: transferRow.destinationWallet.ledgerAccountId, amountMinor: -500n },
            ],
          });

          await transaction.$queryRaw(
            Prisma.sql`SELECT set_config('app.reversal_write', 'on', true)`,
          );
          await transaction.transferReversal.create({
            data: {
              id: reversalId,
              reference: forgedReference,
              transferId: transferRow.id,
              actorUserId: sender.user.id,
              ledgerTransactionId: forgedLedger.id,
              currency: transferRow.currency,
              amountMinor: transferRow.amountMinor,
            },
          });

          await transaction.$queryRaw(Prisma.sql`SELECT set_config('app.audit_write', 'on', true)`);
          await transaction.auditLog.create({
            data: {
              actorUserId: sender.user.id,
              action: AuditAction.TRANSFER_REVERSED,
              transferId: transferRow.id,
              reversalId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow();

    expect(await prisma.transferReversal.count({ where: { transferId: original.id } })).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { reference: forgedReference } })).toBe(0);

    const [sourceWallet, destinationWallet] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: sender.initialWallet.id } }),
      prisma.wallet.findUniqueOrThrow({ where: { id: recipient.initialWallet.id } }),
    ]);
    expect(sourceWallet.currentBalanceMinor).toBe(3_000n);
    expect(destinationWallet.currentBalanceMinor).toBe(2_000n);
  });
});
