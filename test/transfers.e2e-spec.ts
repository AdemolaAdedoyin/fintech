import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, IdempotencyStatus, Prisma, TransferStatus } from '@prisma/client';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

interface WalletBody {
  id: string;
  currency: Currency;
  status: string;
  currentBalanceMinor: string;
}

interface AuthBody {
  accessToken: string;
  user: { id: string };
  initialWallet: WalletBody;
}

interface TransferBody {
  id: string;
  reference: string;
  sourceWalletId: string;
  destinationWalletId: string;
  beneficiaryId: string | null;
  currency: Currency;
  amountMinor: string;
  status: TransferStatus;
}

interface BeneficiaryBody {
  id: string;
  walletId: string;
  label: string;
  currency: Currency;
}

describe('Transfers, idempotency, and beneficiaries (e2e)', () => {
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
      'phase-four-transfer-secret-that-is-longer-than-thirty-two-characters';
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

  async function register(label: string, currency: Currency = Currency.USD) {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        password: 'correct-horse-battery-staple',
        firstName: 'Phase',
        lastName: 'Four',
        currency,
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
      description: 'Phase 4 transfer test funding',
      postings: [
        { accountId: clearing.id, amountMinor: -amountMinor },
        { accountId: wallet.ledgerAccountId, amountMinor },
      ],
    });
  }

  function createTransfer(
    token: string,
    idempotencyKey: string | undefined,
    body: Record<string, unknown>,
  ) {
    const pending = request(httpServer)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${token}`);

    if (idempotencyKey) {
      pending.set('Idempotency-Key', idempotencyKey);
    }

    return pending.send(body);
  }

  it('moves money atomically and scopes transfer history to the sender', async () => {
    const sender = await register('direct-sender');
    const recipient = await register('direct-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const response = await createTransfer(sender.accessToken, `${runId}-direct`, {
      sourceWalletId: sender.initialWallet.id,
      destinationWalletId: recipient.initialWallet.id,
      amountMinor: '4000',
    }).expect(HttpStatus.CREATED);

    const body = response.body as TransferBody;
    expect(body.status).toBe(TransferStatus.COMPLETED);
    expect(body.amountMinor).toBe('4000');
    expect(body.sourceWalletId).toBe(sender.initialWallet.id);
    expect(body.destinationWalletId).toBe(recipient.initialWallet.id);
    expect(body.beneficiaryId).toBeNull();

    const [sourceAfter, destinationAfter, storedTransfer] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: sender.initialWallet.id } }),
      prisma.wallet.findUniqueOrThrow({ where: { id: recipient.initialWallet.id } }),
      prisma.transfer.findUniqueOrThrow({
        where: { id: body.id },
        include: { ledgerTransaction: { include: { postings: true } } },
      }),
    ]);

    expect(sourceAfter.currentBalanceMinor).toBe(6_000n);
    expect(destinationAfter.currentBalanceMinor).toBe(4_000n);
    expect(storedTransfer.ledgerTransaction.sealedAt).toBeInstanceOf(Date);
    expect(storedTransfer.ledgerTransaction.postings).toHaveLength(2);
    expect(
      storedTransfer.ledgerTransaction.postings.reduce(
        (sum, posting) => sum + posting.amountMinor,
        0n,
      ),
    ).toBe(0n);

    const list = await request(httpServer)
      .get('/api/v1/transfers')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.OK);
    expect((list.body as TransferBody[]).some((transfer) => transfer.id === body.id)).toBe(true);

    await request(httpServer)
      .get(`/api/v1/transfers/${body.id}`)
      .set('Authorization', `Bearer ${recipient.accessToken}`)
      .expect(HttpStatus.NOT_FOUND);
  });

  it('replays a successful idempotent transfer and rejects key reuse with a different request', async () => {
    const sender = await register('replay-sender');
    const recipient = await register('replay-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const key = `${runId}-replay`;
    const payload = {
      sourceWalletId: sender.initialWallet.id,
      destinationWalletId: recipient.initialWallet.id,
      amountMinor: '2500',
    };

    const first = await createTransfer(sender.accessToken, key, payload).expect(HttpStatus.CREATED);
    const replay = await createTransfer(sender.accessToken, key, payload).expect(
      HttpStatus.CREATED,
    );

    expect((replay.body as TransferBody).id).toBe((first.body as TransferBody).id);
    expect(await prisma.transfer.count({ where: { id: (first.body as TransferBody).id } })).toBe(1);

    const [sourceAfter, destinationAfter] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { id: sender.initialWallet.id } }),
      prisma.wallet.findUniqueOrThrow({ where: { id: recipient.initialWallet.id } }),
    ]);
    expect(sourceAfter.currentBalanceMinor).toBe(7_500n);
    expect(destinationAfter.currentBalanceMinor).toBe(2_500n);

    await createTransfer(sender.accessToken, key, {
      ...payload,
      amountMinor: '2501',
    }).expect(HttpStatus.CONFLICT);
  });

  it('persists a failed idempotent result so later funds cannot change the same request outcome', async () => {
    const sender = await register('failed-sender');
    const recipient = await register('failed-recipient');
    await fund(sender.initialWallet.id, 1_000n);

    const key = `${runId}-failed`;
    const payload = {
      sourceWalletId: sender.initialWallet.id,
      destinationWalletId: recipient.initialWallet.id,
      amountMinor: '8000',
    };

    await createTransfer(sender.accessToken, key, payload).expect(HttpStatus.CONFLICT);

    const failedRecord = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        userId_scope_key: {
          userId: sender.user.id,
          scope: 'internal-transfer',
          key,
        },
      },
    });
    expect(failedRecord.status).toBe(IdempotencyStatus.FAILED);
    expect(failedRecord.responseStatus).toBe(HttpStatus.CONFLICT);
    expect(failedRecord.transferId).toBeNull();

    await fund(sender.initialWallet.id, 10_000n);
    await createTransfer(sender.accessToken, key, payload).expect(HttpStatus.CONFLICT);

    expect(
      await prisma.transfer.count({
        where: {
          senderUserId: sender.user.id,
          destinationWalletId: recipient.initialWallet.id,
          amountMinor: 8_000n,
        },
      }),
    ).toBe(0);
  });

  it('serializes competing $80 transfers from a $100 wallet so exactly one succeeds', async () => {
    const sender = await register('concurrent-sender');
    const recipientA = await register('concurrent-recipient-a');
    const recipientB = await register('concurrent-recipient-b');
    await fund(sender.initialWallet.id, 10_000n);

    const [responseA, responseB] = await Promise.all([
      createTransfer(sender.accessToken, `${runId}-concurrent-a`, {
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId: recipientA.initialWallet.id,
        amountMinor: '8000',
      }),
      createTransfer(sender.accessToken, `${runId}-concurrent-b`, {
        sourceWalletId: sender.initialWallet.id,
        destinationWalletId: recipientB.initialWallet.id,
        amountMinor: '8000',
      }),
    ]);

    expect([responseA.status, responseB.status].sort()).toEqual([
      HttpStatus.CREATED,
      HttpStatus.CONFLICT,
    ]);

    const sourceAfter = await prisma.wallet.findUniqueOrThrow({
      where: { id: sender.initialWallet.id },
    });
    expect(sourceAfter.currentBalanceMinor).toBe(2_000n);
    expect(
      await prisma.transfer.count({
        where: {
          senderUserId: sender.user.id,
          sourceWalletId: sender.initialWallet.id,
          amountMinor: 8_000n,
        },
      }),
    ).toBe(1);
  });

  it('deduplicates simultaneous retries carrying the same idempotency key', async () => {
    const sender = await register('same-key-sender');
    const recipient = await register('same-key-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const key = `${runId}-same-key`;
    const payload = {
      sourceWalletId: sender.initialWallet.id,
      destinationWalletId: recipient.initialWallet.id,
      amountMinor: '3000',
    };

    const [responseA, responseB] = await Promise.all([
      createTransfer(sender.accessToken, key, payload),
      createTransfer(sender.accessToken, key, payload),
    ]);

    expect(responseA.status).toBe(HttpStatus.CREATED);
    expect(responseB.status).toBe(HttpStatus.CREATED);
    expect((responseA.body as TransferBody).id).toBe((responseB.body as TransferBody).id);

    expect(
      await prisma.transfer.count({
        where: {
          senderUserId: sender.user.id,
          destinationWalletId: recipient.initialWallet.id,
          amountMinor: 3_000n,
        },
      }),
    ).toBe(1);
  });

  it('supports soft-deleted beneficiaries while preserving historical transfer links', async () => {
    const sender = await register('beneficiary-sender');
    const recipient = await register('beneficiary-recipient');
    await fund(sender.initialWallet.id, 10_000n);

    const created = await request(httpServer)
      .post('/api/v1/beneficiaries')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({
        walletId: recipient.initialWallet.id,
        label: '  Primary recipient  ',
      })
      .expect(HttpStatus.CREATED);

    const beneficiary = created.body as BeneficiaryBody;
    expect(beneficiary.label).toBe('Primary recipient');
    expect(beneficiary.walletId).toBe(recipient.initialWallet.id);

    const transferResponse = await createTransfer(sender.accessToken, `${runId}-beneficiary`, {
      sourceWalletId: sender.initialWallet.id,
      beneficiaryId: beneficiary.id,
      amountMinor: '2000',
    }).expect(HttpStatus.CREATED);
    const transfer = transferResponse.body as TransferBody;
    expect(transfer.beneficiaryId).toBe(beneficiary.id);

    await request(httpServer)
      .delete(`/api/v1/beneficiaries/${beneficiary.id}`)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.NO_CONTENT);

    const list = await request(httpServer)
      .get('/api/v1/beneficiaries')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .expect(HttpStatus.OK);
    expect(list.body).toEqual([]);

    await createTransfer(sender.accessToken, `${runId}-deleted-beneficiary`, {
      sourceWalletId: sender.initialWallet.id,
      beneficiaryId: beneficiary.id,
      amountMinor: '1000',
    }).expect(HttpStatus.NOT_FOUND);

    const storedTransfer = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(storedTransfer.beneficiaryId).toBe(beneficiary.id);

    const restored = await request(httpServer)
      .post('/api/v1/beneficiaries')
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({
        walletId: recipient.initialWallet.id,
        label: 'Restored recipient',
      })
      .expect(HttpStatus.CREATED);
    expect((restored.body as BeneficiaryBody).id).toBe(beneficiary.id);
  });

  it('rejects missing idempotency keys and cross-currency transfers', async () => {
    const sender = await register('validation-sender', Currency.USD);
    const recipient = await register('validation-recipient', Currency.NGN);
    await fund(sender.initialWallet.id, 1_000n);

    const payload = {
      sourceWalletId: sender.initialWallet.id,
      destinationWalletId: recipient.initialWallet.id,
      amountMinor: '100',
    };

    await createTransfer(sender.accessToken, undefined, payload).expect(HttpStatus.BAD_REQUEST);
    await createTransfer(sender.accessToken, `${runId}-currency`, payload).expect(
      HttpStatus.BAD_REQUEST,
    );
  });

  it('rejects direct transfer-row creation outside the guarded transfer write path', async () => {
    const sender = await register('guard-sender');
    const recipient = await register('guard-recipient');
    await fund(sender.initialWallet.id, 500n);

    const source = await prisma.wallet.findUniqueOrThrow({
      where: { id: sender.initialWallet.id },
    });
    const destination = await prisma.wallet.findUniqueOrThrow({
      where: { id: recipient.initialWallet.id },
    });
    const ledgerReference = `transfer:${randomUUID()}`;
    const ledgerTransaction = await ledger.post({
      reference: ledgerReference,
      currency: Currency.USD,
      postings: [
        { accountId: source.ledgerAccountId, amountMinor: -100n },
        { accountId: destination.ledgerAccountId, amountMinor: 100n },
      ],
    });

    await expect(
      prisma.transfer.create({
        data: {
          reference: ledgerReference,
          senderUserId: sender.user.id,
          sourceWalletId: source.id,
          destinationWalletId: destination.id,
          ledgerTransactionId: ledgerTransaction.id,
          currency: Currency.USD,
          amountMinor: 100n,
          status: TransferStatus.COMPLETED,
          completedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.transfer.count({ where: { reference: ledgerReference } })).toBe(0);
  });

  it('rejects a forged completed transfer at the deferred database integrity boundary', async () => {
    const sender = await register('integrity-sender');
    const recipient = await register('integrity-recipient');
    await fund(sender.initialWallet.id, 500n);

    const source = await prisma.wallet.findUniqueOrThrow({
      where: { id: sender.initialWallet.id },
    });
    const destination = await prisma.wallet.findUniqueOrThrow({
      where: { id: recipient.initialWallet.id },
    });
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ledgerReference = `transfer:${randomUUID()}`;
    const unrelatedLedger = await ledger.post({
      reference: ledgerReference,
      currency: Currency.USD,
      postings: [
        { accountId: clearing.id, amountMinor: -100n },
        { accountId: destination.ledgerAccountId, amountMinor: 100n },
      ],
    });

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT set_config('app.transfer_write', 'on', true)`,
        );
        await transaction.transfer.create({
          data: {
            reference: ledgerReference,
            senderUserId: sender.user.id,
            sourceWalletId: source.id,
            destinationWalletId: destination.id,
            ledgerTransactionId: unrelatedLedger.id,
            currency: Currency.USD,
            amountMinor: 100n,
            status: TransferStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.transfer.count({ where: { reference: ledgerReference } })).toBe(0);
  });
});
