import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, LedgerAccountKind, WalletStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletsService } from '../src/wallets/wallets.service';

describe('Ledger wallet lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let wallets: WalletsService;

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5432/fintech?schema=public';
    process.env.JWT_ACCESS_SECRET =
      'phase-three-wallet-race-secret-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
    wallets = app.get(WalletsService);
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
          lastName: 'Lifecycle',
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

      return { user, account, wallet };
    });
  }

  it('requires new ledger accounts and product wallets to start paired at the same zero balance', async () => {
    await expect(
      prisma.ledgerAccount.create({
        data: {
          kind: LedgerAccountKind.WALLET,
          currency: Currency.USD,
          balanceMinor: 1n,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.ledgerAccount.create({
        data: {
          kind: LedgerAccountKind.WALLET,
          currency: Currency.USD,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            email: `${runId}-mismatch-${randomUUID()}@example.com`,
            passwordHash: 'test-only-password-hash',
            firstName: 'Mismatch',
            lastName: 'Test',
          },
        });
        const account = await transaction.ledgerAccount.create({
          data: {
            kind: LedgerAccountKind.WALLET,
            currency: Currency.USD,
          },
        });

        await transaction.wallet.create({
          data: {
            userId: user.id,
            ledgerAccountId: account.id,
            currency: Currency.USD,
            currentBalanceMinor: 1n,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('serializes wallet closing against a concurrent ledger credit', async () => {
    const { user, account, wallet } = await createWallet(Currency.USD);
    const clearing = await ledger.getExternalClearingAccount(Currency.USD);
    const ledgerReference = `${runId}:close-race`;

    const results = await Promise.allSettled([
      wallets.close(user.id, wallet.id),
      ledger.post({
        reference: ledgerReference,
        currency: Currency.USD,
        postings: [
          { accountId: clearing.id, amountMinor: -100n },
          { accountId: account.id, amountMinor: 100n },
        ],
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConflictException);

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const accountAfter = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    const transactionCount = await prisma.ledgerTransaction.count({
      where: { reference: ledgerReference },
    });

    expect(walletAfter.currentBalanceMinor).toBe(accountAfter.balanceMinor);

    if (walletAfter.status === WalletStatus.CLOSED) {
      expect(walletAfter.currentBalanceMinor).toBe(0n);
      expect(transactionCount).toBe(0);
    } else {
      expect(walletAfter.status).toBe(WalletStatus.ACTIVE);
      expect(walletAfter.currentBalanceMinor).toBe(100n);
      expect(transactionCount).toBe(1);
    }
  });
});
