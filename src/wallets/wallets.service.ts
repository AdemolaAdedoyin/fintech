import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Currency, Prisma, WalletStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toWalletResponse } from './wallet.mapper';

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, currency: Currency) {
    try {
      const wallet = await this.prisma.wallet.create({
        data: { userId, currency },
      });

      return toWalletResponse(wallet);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A ${currency} wallet already exists for this account`);
      }

      throw error;
    }
  }

  async findAllForUser(userId: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { currency: 'asc' }],
    });

    return wallets.map(toWalletResponse);
  }

  async findOneForUser(userId: string, walletId: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: {
        id: walletId,
        userId,
      },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return toWalletResponse(wallet);
  }

  async close(userId: string, walletId: string) {
    const wallet = await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.wallet.findFirst({
          where: {
            id: walletId,
            userId,
          },
        });

        if (!current) {
          throw new NotFoundException('Wallet not found');
        }

        if (current.status === WalletStatus.CLOSED) {
          return current;
        }

        if (current.status === WalletStatus.FROZEN) {
          throw new ConflictException('A frozen wallet cannot be closed');
        }

        if (current.currentBalanceMinor !== 0n) {
          throw new ConflictException('Wallet balance must be zero before it can be closed');
        }

        return transaction.wallet.update({
          where: { id: current.id },
          data: { status: WalletStatus.CLOSED },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return toWalletResponse(wallet);
  }
}
