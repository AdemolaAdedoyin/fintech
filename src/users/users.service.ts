import { Injectable } from '@nestjs/common';
import { Currency, LedgerAccountKind, type User, type Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type SafeUser = Pick<
  User,
  'id' | 'email' | 'firstName' | 'lastName' | 'createdAt' | 'updatedAt'
>;

export interface CreatedUserWithWallet {
  user: SafeUser;
  wallet: Wallet;
}

interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  currency?: Currency;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
  }

  findSafeById(id: string): Promise<SafeUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async createWithInitialWallet(input: CreateUserInput): Promise<CreatedUserWithWallet> {
    const currency = input.currency ?? Currency.USD;

    return this.prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          email: this.normalizeEmail(input.email),
          passwordHash: input.passwordHash,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
        },
      });

      const ledgerAccount = await transaction.ledgerAccount.create({
        data: {
          kind: LedgerAccountKind.WALLET,
          currency,
        },
      });

      const wallet = await transaction.wallet.create({
        data: {
          userId: created.id,
          ledgerAccountId: ledgerAccount.id,
          currency,
        },
      });

      const user: SafeUser = {
        id: created.id,
        email: created.email,
        firstName: created.firstName,
        lastName: created.lastName,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };

      return { user, wallet };
    });
  }
}
