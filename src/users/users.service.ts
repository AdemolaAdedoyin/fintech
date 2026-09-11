import { Injectable } from '@nestjs/common';
import { Currency, type User, type Wallet } from '@prisma/client';
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
    const created = await this.prisma.user.create({
      data: {
        email: this.normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        wallets: {
          create: {
            currency: input.currency ?? Currency.USD,
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        updatedAt: true,
        wallets: true,
      },
    });

    const [wallet] = created.wallets;
    if (!wallet) {
      throw new Error('Initial wallet was not created with the user');
    }

    const { wallets: _wallets, ...user } = created;
    return { user, wallet };
  }
}
