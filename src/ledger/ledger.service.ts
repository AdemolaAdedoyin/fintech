import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  Currency,
  LedgerAccountKind,
  Prisma,
  WalletStatus,
  type LedgerAccount,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { externalClearingAccountKey } from './ledger.constants';
import {
  isSupportedMinorUnitValue,
  normalizeLedgerTransactionInput,
  type LedgerTransactionInput,
} from './ledger.invariants';

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async getExternalClearingAccount(currency: Currency): Promise<LedgerAccount> {
    const account = await this.prisma.ledgerAccount.findUnique({
      where: { systemKey: externalClearingAccountKey(currency) },
    });

    if (!account) {
      throw new NotFoundException(`No external clearing account exists for ${currency}`);
    }

    return account;
  }

  async post(input: LedgerTransactionInput) {
    try {
      return await this.prisma.$transaction(
        (transaction) => this.postWithinTransaction(transaction, input),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException('Ledger reference already exists');
        }

        if (this.isSerializationConflict(error)) {
          throw new ConflictException('Concurrent ledger update detected; retry the operation');
        }
      }

      throw error;
    }
  }

  async postWithinTransaction(
    transaction: Prisma.TransactionClient,
    input: LedgerTransactionInput,
  ) {
    const normalized = normalizeLedgerTransactionInput(input);
    const accountIds = normalized.postings.map((posting) => posting.accountId).sort();

    await transaction.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "LedgerAccount"
        WHERE "id" IN (${Prisma.join(
          accountIds.map((accountId) => Prisma.sql`${accountId}::uuid`),
        )})
        ORDER BY "id"
        FOR UPDATE
      `,
    );

    const accounts = await transaction.ledgerAccount.findMany({
      where: { id: { in: accountIds } },
      include: { wallet: true },
    });

    if (accounts.length !== accountIds.length) {
      throw new NotFoundException('One or more ledger accounts do not exist');
    }

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const nextBalances = new Map<string, bigint>();

    for (const posting of normalized.postings) {
      const account = accountById.get(posting.accountId);
      if (!account) {
        throw new NotFoundException('One or more ledger accounts do not exist');
      }

      if (account.currency !== normalized.currency) {
        throw new BadRequestException('All ledger accounts must use the transaction currency');
      }

      if (account.kind === LedgerAccountKind.WALLET) {
        if (!account.wallet) {
          throw new InternalServerErrorException(
            'Wallet ledger account is not linked to a product wallet',
          );
        }

        if (account.wallet.currency !== account.currency) {
          throw new InternalServerErrorException(
            'Wallet and ledger account currencies are inconsistent',
          );
        }

        if (account.wallet.currentBalanceMinor !== account.balanceMinor) {
          throw new InternalServerErrorException(
            'Wallet balance snapshot is inconsistent with its ledger account',
          );
        }

        if (account.wallet.status !== WalletStatus.ACTIVE) {
          throw new ConflictException('Only active wallets can receive ledger postings');
        }
      } else if (account.wallet) {
        throw new InternalServerErrorException(
          'System ledger accounts cannot be linked to product wallets',
        );
      }

      const nextBalance = account.balanceMinor + posting.amountMinor;
      if (!isSupportedMinorUnitValue(nextBalance)) {
        throw new ConflictException('Ledger posting would exceed the supported BIGINT range');
      }

      if (!account.allowNegative && nextBalance < 0n) {
        throw new ConflictException('Insufficient funds for ledger posting');
      }

      nextBalances.set(account.id, nextBalance);
    }

    await transaction.$queryRaw(Prisma.sql`SELECT set_config('app.ledger_write', 'on', true)`);

    const ledgerTransaction = await transaction.ledgerTransaction.create({
      data: {
        reference: normalized.reference,
        currency: normalized.currency,
        ...(normalized.description ? { description: normalized.description } : {}),
      },
    });

    await transaction.ledgerPosting.createMany({
      data: normalized.postings.map((posting) => ({
        ledgerTransactionId: ledgerTransaction.id,
        accountId: posting.accountId,
        amountMinor: posting.amountMinor,
      })),
    });

    for (const account of accounts) {
      const nextBalance = nextBalances.get(account.id);
      if (nextBalance === undefined) {
        throw new InternalServerErrorException('Ledger balance calculation was incomplete');
      }

      await transaction.ledgerAccount.update({
        where: { id: account.id },
        data: { balanceMinor: nextBalance },
      });
    }

    const sealedAt = new Date();
    await transaction.ledgerTransaction.update({
      where: { id: ledgerTransaction.id },
      data: { sealedAt },
    });

    return transaction.ledgerTransaction.findUniqueOrThrow({
      where: { id: ledgerTransaction.id },
      include: {
        postings: {
          orderBy: { accountId: 'asc' },
        },
      },
    });
  }

  private isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
    return error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001');
  }
}
