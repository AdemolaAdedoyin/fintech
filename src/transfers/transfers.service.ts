import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  IdempotencyStatus,
  Prisma,
  TransferStatus,
  OutboxEventType,
  WalletStatus,
  type Transfer,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { LedgerService } from '../ledger/ledger.service';
import { MAX_MINOR_UNITS } from '../ledger/ledger.invariants';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTransferDto } from './dto/create-transfer.dto';
import { toTransferResponse } from './transfer.mapper';

const IDEMPOTENCY_SCOPE = 'internal-transfer';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ExistingIdempotencyRecord {
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  errorMessage: string | null;
  transfer: Transfer | null;
}

type TransferAttemptOutcome =
  { kind: 'success'; transfer: Transfer } | { kind: 'failure'; status: number; message: string };

interface NormalizedTransferRequest {
  sourceWalletId: string;
  destinationWalletId?: string;
  beneficiaryId?: string;
  amountMinor: bigint;
  amountMinorText: string;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async create(
    senderUserId: string,
    idempotencyKeyHeader: string | undefined,
    input: CreateTransferDto,
  ) {
    const idempotencyKey = this.normalizeIdempotencyKey(idempotencyKeyHeader);
    const request = this.normalizeTransferRequest(input);
    const requestHash = this.hashRequest(request);

    let outcome: TransferAttemptOutcome;

    try {
      outcome = await this.prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              userId_scope_key: {
                userId: senderUserId,
                scope: IDEMPOTENCY_SCOPE,
                key: idempotencyKey,
              },
            },
            include: { transfer: true },
          });

          if (existing) {
            return this.resolveExistingIdempotency(existing, requestHash);
          }

          const claim = await transaction.idempotencyRecord.create({
            data: {
              userId: senderUserId,
              scope: IDEMPOTENCY_SCOPE,
              key: idempotencyKey,
              requestHash,
            },
            select: { id: true },
          });

          try {
            const sourceWallet = await transaction.wallet.findFirst({
              where: {
                id: request.sourceWalletId,
                userId: senderUserId,
              },
              select: {
                id: true,
                ledgerAccountId: true,
                currency: true,
                status: true,
              },
            });

            if (!sourceWallet) {
              throw new NotFoundException('Source wallet not found');
            }

            if (sourceWallet.status !== WalletStatus.ACTIVE) {
              throw new ConflictException('Source wallet must be active');
            }

            let destinationWallet: {
              id: string;
              ledgerAccountId: string;
              currency: typeof sourceWallet.currency;
              status: WalletStatus;
            };
            let beneficiaryId: string | null = null;

            if (request.beneficiaryId) {
              const beneficiary = await transaction.beneficiary.findFirst({
                where: {
                  id: request.beneficiaryId,
                  ownerUserId: senderUserId,
                  deletedAt: null,
                },
                select: {
                  id: true,
                  wallet: {
                    select: {
                      id: true,
                      ledgerAccountId: true,
                      currency: true,
                      status: true,
                    },
                  },
                },
              });

              if (!beneficiary) {
                throw new NotFoundException('Beneficiary not found');
              }

              beneficiaryId = beneficiary.id;
              destinationWallet = beneficiary.wallet;
            } else {
              const destinationWalletId = request.destinationWalletId;
              if (!destinationWalletId) {
                throw new InternalServerErrorException('Transfer destination was not resolved');
              }

              const directDestination = await transaction.wallet.findUnique({
                where: { id: destinationWalletId },
                select: {
                  id: true,
                  ledgerAccountId: true,
                  currency: true,
                  status: true,
                },
              });

              if (!directDestination) {
                throw new NotFoundException('Destination wallet is unavailable');
              }

              destinationWallet = directDestination;
            }

            if (destinationWallet.status !== WalletStatus.ACTIVE) {
              throw new ConflictException('Destination wallet must be active');
            }

            if (sourceWallet.id === destinationWallet.id) {
              throw new BadRequestException('Source and destination wallets must be different');
            }

            if (sourceWallet.currency !== destinationWallet.currency) {
              throw new BadRequestException('Internal transfers must use the same currency');
            }

            const transferId = randomUUID();
            const reference = `transfer:${transferId}`;
            const ledgerTransaction = await this.ledger.postWithinTransaction(transaction, {
              reference,
              currency: sourceWallet.currency,
              description: 'Internal wallet transfer',
              postings: [
                {
                  accountId: sourceWallet.ledgerAccountId,
                  amountMinor: -request.amountMinor,
                },
                {
                  accountId: destinationWallet.ledgerAccountId,
                  amountMinor: request.amountMinor,
                },
              ],
            });

            await transaction.$queryRaw(
              Prisma.sql`SELECT set_config('app.transfer_write', 'on', true)`,
            );

            const completedAt = new Date();
            const transfer = await transaction.transfer.create({
              data: {
                id: transferId,
                reference,
                senderUserId,
                sourceWalletId: sourceWallet.id,
                destinationWalletId: destinationWallet.id,
                ...(beneficiaryId ? { beneficiaryId } : {}),
                ledgerTransactionId: ledgerTransaction.id,
                currency: sourceWallet.currency,
                amountMinor: request.amountMinor,
                status: TransferStatus.COMPLETED,
                completedAt,
              },
            });

            await transaction.$queryRaw(
              Prisma.sql`SELECT set_config('app.audit_write', 'on', true)`,
            );
            await transaction.auditLog.create({
              data: {
                actorUserId: senderUserId,
                action: AuditAction.TRANSFER_CREATED,
                transferId: transfer.id,
              },
            });

            await transaction.outboxEvent.create({
              data: {
                type: OutboxEventType.TRANSFER_COMPLETED,
                aggregateType: 'Transfer',
                aggregateId: transfer.id,
                actorUserId: senderUserId,
                payload: {
                  transferId: transfer.id,
                  amountMinor: transfer.amountMinor.toString(),
                  currency: transfer.currency,
                },
              },
            });

            await transaction.idempotencyRecord.update({
              where: { id: claim.id },
              data: {
                status: IdempotencyStatus.COMPLETED,
                responseStatus: HttpStatus.CREATED,
                transferId: transfer.id,
              },
            });

            return { kind: 'success', transfer } satisfies TransferAttemptOutcome;
          } catch (error) {
            if (error instanceof HttpException) {
              const status = error.getStatus();
              if (status >= 400 && status < 500) {
                const message = error.message.slice(0, 255);
                await transaction.idempotencyRecord.update({
                  where: { id: claim.id },
                  data: {
                    status: IdempotencyStatus.FAILED,
                    responseStatus: status,
                    errorMessage: message,
                  },
                });

                return { kind: 'failure', status, message } satisfies TransferAttemptOutcome;
              }
            }

            throw error;
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          outcome = await this.replayAfterIdempotencyRace(
            senderUserId,
            idempotencyKey,
            requestHash,
          );
          return this.unwrapOutcome(outcome);
        }

        if (this.isSerializationConflict(error)) {
          throw new ConflictException(
            'Concurrent transfer update detected; retry using the same Idempotency-Key',
          );
        }
      }

      throw error;
    }

    return this.unwrapOutcome(outcome);
  }

  async findAllForUser(senderUserId: string) {
    const transfers = await this.prisma.transfer.findMany({
      where: { senderUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });

    return transfers.map(toTransferResponse);
  }

  async findOneForUser(senderUserId: string, transferId: string) {
    const transfer = await this.prisma.transfer.findFirst({
      where: {
        id: transferId,
        senderUserId,
      },
    });

    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }

    return toTransferResponse(transfer);
  }

  private normalizeIdempotencyKey(value: string | undefined): string {
    if (!value) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const key = value.trim();
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen',
      );
    }

    return key;
  }

  private normalizeTransferRequest(input: CreateTransferDto): NormalizedTransferRequest {
    const hasDestination = Boolean(input.destinationWalletId);
    const hasBeneficiary = Boolean(input.beneficiaryId);
    if (hasDestination === hasBeneficiary) {
      throw new BadRequestException('Provide exactly one of destinationWalletId or beneficiaryId');
    }

    let amountMinor: bigint;
    try {
      amountMinor = BigInt(input.amountMinor);
    } catch {
      throw new BadRequestException('amountMinor must be a positive integer string in minor units');
    }

    if (amountMinor <= 0n || amountMinor > MAX_MINOR_UNITS) {
      throw new BadRequestException('amountMinor exceeds the supported BIGINT range');
    }

    return {
      sourceWalletId: input.sourceWalletId.toLowerCase(),
      ...(input.destinationWalletId
        ? { destinationWalletId: input.destinationWalletId.toLowerCase() }
        : {}),
      ...(input.beneficiaryId ? { beneficiaryId: input.beneficiaryId.toLowerCase() } : {}),
      amountMinor,
      amountMinorText: amountMinor.toString(),
    };
  }

  private hashRequest(request: NormalizedTransferRequest): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          sourceWalletId: request.sourceWalletId,
          destinationWalletId: request.destinationWalletId ?? null,
          beneficiaryId: request.beneficiaryId ?? null,
          amountMinor: request.amountMinorText,
        }),
      )
      .digest('hex');
  }

  private resolveExistingIdempotency(
    record: ExistingIdempotencyRecord,
    requestHash: string,
  ): TransferAttemptOutcome {
    if (record.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key has already been used with a different transfer request',
      );
    }

    if (record.status === IdempotencyStatus.COMPLETED) {
      if (!record.transfer) {
        throw new InternalServerErrorException(
          'Completed idempotency record is missing its transfer',
        );
      }

      return { kind: 'success', transfer: record.transfer };
    }

    if (record.status === IdempotencyStatus.FAILED) {
      if (!record.responseStatus || !record.errorMessage) {
        throw new InternalServerErrorException(
          'Failed idempotency record is missing its stored response',
        );
      }

      return {
        kind: 'failure',
        status: record.responseStatus,
        message: record.errorMessage,
      };
    }

    throw new ConflictException('Idempotent transfer request is still processing');
  }

  private async replayAfterIdempotencyRace(
    senderUserId: string,
    key: string,
    requestHash: string,
  ): Promise<TransferAttemptOutcome> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_scope_key: {
          userId: senderUserId,
          scope: IDEMPOTENCY_SCOPE,
          key,
        },
      },
      include: { transfer: true },
    });

    if (!existing) {
      throw new ConflictException('Concurrent transfer conflict detected; retry the request');
    }

    return this.resolveExistingIdempotency(existing, requestHash);
  }

  private isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
    return error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001');
  }

  private unwrapOutcome(outcome: TransferAttemptOutcome) {
    if (outcome.kind === 'failure') {
      throw new HttpException(outcome.message, outcome.status);
    }

    return toTransferResponse(outcome.transfer);
  }
}
