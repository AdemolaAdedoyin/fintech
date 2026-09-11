import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WalletStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toBeneficiaryResponse } from './beneficiary.mapper';

@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerUserId: string, walletId: string, label: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: {
        id: true,
        userId: true,
        currency: true,
        status: true,
      },
    });

    if (!wallet) {
      throw new NotFoundException('Beneficiary wallet is unavailable');
    }

    if (wallet.userId === ownerUserId) {
      throw new BadRequestException('A beneficiary must reference another user wallet');
    }

    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new ConflictException('Beneficiary wallet must be active');
    }

    const existing = await this.prisma.beneficiary.findUnique({
      where: {
        ownerUserId_walletId: {
          ownerUserId,
          walletId,
        },
      },
      include: {
        wallet: {
          select: { currency: true },
        },
      },
    });

    if (existing) {
      if (existing.deletedAt) {
        const restored = await this.prisma.beneficiary.update({
          where: { id: existing.id },
          data: {
            label,
            deletedAt: null,
          },
          include: {
            wallet: {
              select: { currency: true },
            },
          },
        });

        return toBeneficiaryResponse(restored);
      }

      throw new ConflictException('Beneficiary already exists');
    }

    try {
      const beneficiary = await this.prisma.beneficiary.create({
        data: {
          ownerUserId,
          walletId,
          label,
        },
        include: {
          wallet: {
            select: { currency: true },
          },
        },
      });

      return toBeneficiaryResponse(beneficiary);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Beneficiary already exists');
      }

      throw error;
    }
  }

  async findAll(ownerUserId: string) {
    const beneficiaries = await this.prisma.beneficiary.findMany({
      where: {
        ownerUserId,
        deletedAt: null,
      },
      include: {
        wallet: {
          select: { currency: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return beneficiaries.map(toBeneficiaryResponse);
  }

  async remove(ownerUserId: string, beneficiaryId: string): Promise<void> {
    const beneficiary = await this.prisma.beneficiary.findFirst({
      where: {
        id: beneficiaryId,
        ownerUserId,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!beneficiary) {
      throw new NotFoundException('Beneficiary not found');
    }

    await this.prisma.beneficiary.update({
      where: { id: beneficiary.id },
      data: { deletedAt: new Date() },
    });
  }
}
