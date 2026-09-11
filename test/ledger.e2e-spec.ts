import { BadRequestException, ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, LedgerAccountKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { MAX_MINOR_UNITS } from '../src/ledger/ledger.invariants';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Ledger core (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const reference = (label: string) => `${runId}:${label}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5432/fintech?schema=public';
    process.env.JWT_ACCESS_SECRET =
      'phase-three-ledger-secret-that-is-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createWallet(currency: Currency = Currency.USD) {
    return prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          email: `${runId}-${randomUUID()}@example.com`,
          passwordHash: 'test-only-password-hash',
          firstName: 'Ledger',
          lastName: 'Test',
        },
      });
      const account = await transaction.ledgerAccount.create({
        data: {
          kind: LedgerAccountKind.WALLET,
          currency,
        },
      });
      const wallet = await transaction.wallet.create({
        data: {
          userId: user.id,
          ledgerAccountId: account.id,
          currency,
        },
      });

      return { account, wallet };
    });
  }

  it('posts a balanced transaction atomically and seals immutable history', async () => {
    const { account, wallet } = await createWallet(Currency.USD);
    const clearingBefore = await ledger.getExternalClearingAccount(Currency.USD);

    const posted = await ledger.post({
      reference: reference('balanced-credit'),
      currency: Currency.USD,
      description: 'Test wallet credit',
      postings: [
        { accountId: clearingBefore.id, amountMinor: -10_000n },
        { accountId: account.id, amountMinor: 10_000n },
      ],
    });

    expect(posted.sealedAt).toBeInstanceOf(Date);
    expect(posted.postings).toHaveLength(2);
    expect(posted.postings.reduce((sum, posting) => sum + posting.amountMinor, 0n)).toBe(0n);

    const storedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const storedAccount = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    const clearingAfter = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: clearingBefore.id },
    });

    expect(storedWallet.currentBalanceMinor).toBe(10_000n);
    expect(storedAccount.balanceMinor).toBe(10_000n);
    expect(clearingAfter.balanceMinor).toBe(clearingBefore.balanceMinor - 10_000n);

    await expect(
      prisma.ledgerPosting.update({
        where: { id: posted.postings[0].id },
        data: { amountMinor: 1n },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.ledgerTransaction.update({
        where: { id: posted.id },
        data: { description: 'mutated history' },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.wallet.update({
        where: { id: wallet.id },
        data: { currentBalanceMinor: 99_999n },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.ledgerAccount.update({
        where: { id: account.id },
        data: { balanceMinor: 99_999n },
      }),
    ).rejects.toThrow();
  });

  it('rejects unbalanced requests before any ledger record is written', async () => {
    const { account } = await createWallet(Currency.USD);
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ledgerReference = reference('unbalanced-service');

    await expect(
      ledger.post({
        reference: ledgerReference,
        currency: Currency.USD,
        postings: [
          { accountId: clearing.id, amountMinor: -100n },
          { accountId: account.id, amountMinor: 99n },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await prisma.ledgerTransaction.count({ where: { reference: ledgerReference } })).toBe(0);
  });

  it('enforces balance and currency rules without partial writes', async () => {
    const { account } = await createWallet(Currency.USD);
    const usdClearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ngnClearing = await ledger.getExternalClearingAccount(Currency.NGN);
    const insufficientReference = reference('insufficient');
    const mismatchReference = reference('currency-mismatch');

    await expect(
      ledger.post({
        reference: insufficientReference,
        currency: Currency.USD,
        postings: [
          { accountId: account.id, amountMinor: -1n },
          { accountId: usdClearing.id, amountMinor: 1n },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      ledger.post({
        reference: mismatchReference,
        currency: Currency.USD,
        postings: [
          { accountId: account.id, amountMinor: 1n },
          { accountId: ngnClearing.id, amountMinor: -1n },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const accountAfter = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(accountAfter.balanceMinor).toBe(0n);
    expect(
      await prisma.ledgerTransaction.count({
        where: { reference: { in: [insufficientReference, mismatchReference] } },
      }),
    ).toBe(0);
  });

  it('rejects direct ledger history writes outside the ledger write context', async () => {
    const { account, wallet } = await createWallet(Currency.USD);
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ledgerReference = reference('direct-write-guard');

    await expect(
      prisma.$transaction(async (transaction) => {
        const record = await transaction.ledgerTransaction.create({
          data: {
            reference: ledgerReference,
            currency: Currency.USD,
          },
        });

        await transaction.ledgerPosting.createMany({
          data: [
            {
              ledgerTransactionId: record.id,
              accountId: clearing.id,
              amountMinor: -100n,
            },
            {
              ledgerTransactionId: record.id,
              accountId: account.id,
              amountMinor: 100n,
            },
          ],
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.ledgerTransaction.count({ where: { reference: ledgerReference } })).toBe(0);
    expect(
      (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: account.id } })).balanceMinor,
    ).toBe(0n);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).currentBalanceMinor,
    ).toBe(0n);
  });

  it('rejects an unbalanced transaction at the database commit boundary too', async () => {
    const { account } = await createWallet(Currency.USD);
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ledgerReference = reference('unbalanced-database');

    await expect(
      prisma.$transaction(
        async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT set_config('app.ledger_write', 'on', true)`,
          );

          const record = await transaction.ledgerTransaction.create({
            data: {
              reference: ledgerReference,
              currency: Currency.USD,
            },
          });

          await transaction.ledgerPosting.createMany({
            data: [
              {
                ledgerTransactionId: record.id,
                accountId: clearing.id,
                amountMinor: -100n,
              },
              {
                ledgerTransactionId: record.id,
                accountId: account.id,
                amountMinor: 99n,
              },
            ],
          });

          await transaction.ledgerTransaction.update({
            where: { id: record.id },
            data: { sealedAt: new Date() },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow();

    expect(await prisma.ledgerTransaction.count({ where: { reference: ledgerReference } })).toBe(0);
  });

  it('rejects postings that would overflow a ledger balance snapshot', async () => {
    const { account, wallet } = await createWallet(Currency.USD);
    const systemAccount = await prisma.ledgerAccount.create({
      data: {
        kind: LedgerAccountKind.SYSTEM,
        currency: Currency.USD,
        allowNegative: true,
        systemKey: `test-range:${runId}:${randomUUID()}`,
      },
    });

    await ledger.post({
      reference: reference('range-fund'),
      currency: Currency.USD,
      postings: [
        { accountId: systemAccount.id, amountMinor: -MAX_MINOR_UNITS },
        { accountId: account.id, amountMinor: MAX_MINOR_UNITS },
      ],
    });

    const overflowReference = reference('range-overflow');
    await expect(
      ledger.post({
        reference: overflowReference,
        currency: Currency.USD,
        postings: [
          { accountId: systemAccount.id, amountMinor: -1n },
          { accountId: account.id, amountMinor: 1n },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(
      (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: account.id } })).balanceMinor,
    ).toBe(MAX_MINOR_UNITS);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).currentBalanceMinor,
    ).toBe(MAX_MINOR_UNITS);
    expect(
      (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: systemAccount.id } }))
        .balanceMinor,
    ).toBe(-MAX_MINOR_UNITS);
    expect(await prisma.ledgerTransaction.count({ where: { reference: overflowReference } })).toBe(
      0,
    );
  });

  it('serializes concurrent debits so a wallet cannot overspend', async () => {
    const { account, wallet } = await createWallet(Currency.USD);
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);

    await ledger.post({
      reference: reference('concurrency-fund'),
      currency: Currency.USD,
      postings: [
        { accountId: clearing.id, amountMinor: -100n },
        { accountId: account.id, amountMinor: 100n },
      ],
    });

    const debitReferences = [reference('concurrency-debit-a'), reference('concurrency-debit-b')];
    const results = await Promise.allSettled(
      debitReferences.map((ledgerReference) =>
        ledger.post({
          reference: ledgerReference,
          currency: Currency.USD,
          postings: [
            { accountId: account.id, amountMinor: -80n },
            { accountId: clearing.id, amountMinor: 80n },
          ],
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const accountAfter = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(walletAfter.currentBalanceMinor).toBe(20n);
    expect(accountAfter.balanceMinor).toBe(20n);
    expect(
      await prisma.ledgerTransaction.count({ where: { reference: { in: debitReferences } } }),
    ).toBe(1);
  });
});
