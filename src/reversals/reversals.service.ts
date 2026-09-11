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
  type TransferReversal,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateReversalDto } from './dto/create-reversal.dto';
import { toReversalResponse } from './reversal.mapper';

const IDEMPOTENCY_SCOPE = 'transfer-reversal';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ExistingIdempotencyRecord {
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  errorMessage: string | null;
  reversal: TransferReversal | null;
}

type ReversalAttemptOutcome =
  | { kind: 'success'; reversal: TransferReversal }
  | { kind: 'failure'; status: number; message: string };

interface NormalizedReversalRequest {
  transferId: string;
  reason?: string;
}

@Injectable()
export class ReversalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async create(
    actorUserId: string,
    transferId: string,
    idempotencyKeyHeader: string | undefined,
    input: CreateReversalDto,
  ) {
    const idempotencyKey = this.normalizeIdempotencyKey(idempotencyKeyHeader);
    const request = this.normalizeRequest(transferId, input);
    const requestHash = this.hashRequest(request);

    let outcome: ReversalAttemptOutcome;

    try {
      outcome = await this.prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: {
              userId_scope_key: {
                userId: actorUserId,
                scope: IDEMPOTENCY_SCOPE,
                key: idempotencyKey,
              },
            },
            include: { reversal: true },
          });

          if (existing) {
            return this.resolveExistingIdempotency(existing, requestHash);
          }

          const claim = await transaction.idempotencyRecord.create({
            data: {
              userId: actorUserId,
              scope: IDEMPOTENCY_SCOPE,
              key: idempotencyKey,
              requestHash,
            },
            select: { id: true },
          });

          try {
            await transaction.$queryRaw(
              Prisma.sql`
                SELECT "id"
                FROM "Transfer"
                WHERE "id" = ${request.transferId}::uuid
                FOR UPDATE
              `,
            );

            const transfer = await transaction.transfer.findFirst({
              where: {
                id: request.transferId,
                senderUserId: actorUserId,
              },
              include: {
                sourceWallet: {
                  select: {
                    ledgerAccountId: true,
                  },
                },
                destinationWallet: {
                  select: {
                    ledgerAccountId: true,
                  },
                },
                reversal: true,
              },
            });

            if (!transfer) {
              throw new NotFoundException('Transfer not found');
            }

            if (transfer.status !== TransferStatus.COMPLETED) {
              throw new ConflictException('Only completed transfers can be reversed');
            }

            if (transfer.reversal) {
              throw new ConflictException('Transfer has already been reversed');
            }

            const reversalId = randomUUID();
            const reference = `reversal:${reversalId}`;
            const ledgerTransaction = await this.ledger.postWithinTransaction(transaction, {
              reference,
              currency: transfer.currency,
              description: 'Internal transfer reversal',
              postings: [
                {
                  accountId: transfer.sourceWallet.ledgerAccountId,
                  amountMinor: transfer.amountMinor,
                },
                {
                  accountId: transfer.destinationWallet.ledgerAccountId,
                  amountMinor: -transfer.amountMinor,
                },
              ],
            });

            await transaction.$queryRaw(
              Prisma.sql`SELECT set_config('app.reversal_write', 'on', true)`,
            );
            const reversal = await transaction.transferReversal.create({
              data: {
                id: reversalId,
                reference,
                transferId: transfer.id,
                actorUserId,
                ledgerTransactionId: ledgerTransaction.id,
                currency: transfer.currency,
                amountMinor: transfer.amountMinor,
                ...(request.reason ? { reason: request.reason } : {}),
              },
            });

            await transaction.$queryRaw(
              Prisma.sql`SELECT set_config('app.audit_write', 'on', true)`,
            );
            await transaction.auditLog.create({
              data: {
                actorUserId,
                action: AuditAction.TRANSFER_REVERSED,
                transferId: transfer.id,
                reversalId: reversal.id,
              },
            });

            await transaction.idempotencyRecord.update({
              where: { id: claim.id },
              data: {
                status: IdempotencyStatus.COMPLETED,
                responseStatus: HttpStatus.CREATED,
                reversalId: reversal.id,
              },
            });

            return { kind: 'success', reversal } satisfies ReversalAttemptOutcome;
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

                return { kind: 'failure', status, message } satisfies ReversalAttemptOutcome;
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
          outcome = await this.replayAfterIdempotencyRace(actorUserId, idempotencyKey, requestHash);
          return this.unwrapOutcome(outcome);
        }

        if (this.isSerializationConflict(error)) {
          throw new ConflictException(
            'Concurrent reversal update detected; retry using the same Idempotency-Key',
          );
        }
      }

      throw error;
    }

    return this.unwrapOutcome(outcome);
  }

  async findOneForUser(actorUserId: string, transferId: string) {
    const reversal = await this.prisma.transferReversal.findFirst({
      where: {
        transferId,
        actorUserId,
      },
    });

    if (!reversal) {
      throw new NotFoundException('Reversal not found');
    }

    return toReversalResponse(reversal);
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

  private normalizeRequest(
    transferId: string,
    input: CreateReversalDto,
  ): NormalizedReversalRequest {
    const reason = input.reason?.trim();
    return {
      transferId: transferId.toLowerCase(),
      ...(reason ? { reason } : {}),
    };
  }

  private hashRequest(request: NormalizedReversalRequest): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          transferId: request.transferId,
          reason: request.reason ?? null,
        }),
      )
      .digest('hex');
  }

  private resolveExistingIdempotency(
    record: ExistingIdempotencyRecord,
    requestHash: string,
  ): ReversalAttemptOutcome {
    if (record.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key has already been used with a different reversal request',
      );
    }

    if (record.status === IdempotencyStatus.COMPLETED) {
      if (!record.reversal) {
        throw new InternalServerErrorException(
          'Completed idempotency record is missing its reversal',
        );
      }

      return { kind: 'success', reversal: record.reversal };
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

    throw new ConflictException('Idempotent reversal request is still processing');
  }

  private async replayAfterIdempotencyRace(
    actorUserId: string,
    key: string,
    requestHash: string,
  ): Promise<ReversalAttemptOutcome> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_scope_key: {
          userId: actorUserId,
          scope: IDEMPOTENCY_SCOPE,
          key,
        },
      },
      include: { reversal: true },
    });

    if (!existing) {
      throw new ConflictException('Concurrent reversal conflict detected; retry the request');
    }

    return this.resolveExistingIdempotency(existing, requestHash);
  }

  private isSerializationConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
    return error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001');
  }

  private unwrapOutcome(outcome: ReversalAttemptOutcome) {
    if (outcome.kind === 'failure') {
      throw new HttpException(outcome.message, outcome.status);
    }

    return toReversalResponse(outcome.reversal);
  }
}
