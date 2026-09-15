import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type Payment } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { LedgerService } from '../ledger/ledger.service';
import { MAX_MINOR_UNITS } from '../ledger/ledger.invariants';
import { externalClearingAccountKey } from '../ledger/ledger.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  type PaymentProviderAdapter,
  type VerifiedPaymentEvent,
} from './providers/payment-provider';
import type { CreatePaymentDto, ListPaymentsDto } from './payments.dto';
import { toPaymentResponse } from './payments.mapper';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderAdapter,
  ) {}

  async create(userId: string, header: string | undefined, input: CreatePaymentDto) {
    this.provider.assertEnabled();
    const key = header?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new BadRequestException('A valid Idempotency-Key is required');
    if (
      !/^[1-9][0-9]{0,18}$/.test(input.amountMinor) ||
      BigInt(input.amountMinor) > MAX_MINOR_UNITS
    ) {
      throw new BadRequestException('amountMinor exceeds the positive BIGINT range');
    }
    const walletId = input.walletId.toLowerCase();
    const hash = createHash('sha256')
      .update(JSON.stringify({ walletId, amountMinor: input.amountMinor }))
      .digest('hex');
    let payment: Payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.payment.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
        });
        if (existing) return this.replay(existing, hash);
        const wallet = await tx.wallet.findFirst({ where: { id: walletId, userId } });
        if (!wallet) throw new NotFoundException('Wallet not found');
        if (wallet.status !== 'ACTIVE') throw new ConflictException('Wallet must be active');
        await tx.$queryRaw`SELECT set_config('app.payment_write', 'on', true)`;
        return tx.payment.create({
          data: {
            userId,
            walletId,
            provider: this.provider.name,
            idempotencyKey: key,
            requestHash: hash,
            reference: `payment:${randomUUID()}`,
            amountMinor: BigInt(input.amountMinor),
            currency: wallet.currency,
          },
        });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      const existing = await this.prisma.payment.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      });
      if (!existing)
        throw new ConflictException('Concurrent initialization; retry with the same key');
      payment = this.replay(existing, hash);
    }
    if (payment.status !== 'PENDING') return { ...toPaymentResponse(payment), checkoutUrl: null };
    try {
      // Persist intent before calling the adapter. Retrying a lost response reuses its reference.
      const initialized = await this.provider.initialize({
        reference: payment.reference,
        amountMinor: payment.amountMinor.toString(),
        currency: payment.currency,
      });
      return { ...toPaymentResponse(payment), ...initialized };
    } catch {
      throw new ServiceUnavailableException(
        'Payment initialization unavailable; retry with the same Idempotency-Key',
      );
    }
  }

  private replay(payment: Payment, hash: string): Payment {
    if (payment.requestHash !== hash)
      throw new ConflictException('Idempotency-Key was used with a different payment request');
    return payment;
  }

  async list(userId: string, query: ListPaymentsDto) {
    if (
      query.cursor &&
      !(await this.prisma.payment.findFirst({
        where: { id: query.cursor, userId },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException('Invalid payment cursor');
    }
    const rows = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(toPaymentResponse),
      nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
    };
  }

  async findOne(userId: string, id: string) {
    const payment = await this.prisma.payment.findFirst({ where: { id, userId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return toPaymentResponse(payment);
  }

  async events(userId: string, id: string, query: ListPaymentsDto) {
    await this.findOne(userId, id);
    if (
      query.cursor &&
      !(await this.prisma.providerEvent.findFirst({
        where: { id: query.cursor, paymentId: id },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException('Invalid event cursor');
    }
    const rows = await this.prisma.providerEvent.findMany({
      where: { paymentId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: { id: true, eventId: true, provider: true, status: true, createdAt: true },
    });
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }

  async receive(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined) {
    const event = this.provider.verify(rawBody, timestamp, signature);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.settle(event);
      } catch (error) {
        const transient =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            error.code === 'P2002' ||
            (error.code === 'P2010' && error.meta?.code === '40001'));
        if (!transient) throw error;
        if (attempt === 2)
          throw new ServiceUnavailableException('Concurrent payment settlement; retry callback');
      }
    }
    throw new ServiceUnavailableException('Retry callback');
  }

  private settle(event: VerifiedPaymentEvent) {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Payment[]>(Prisma.sql`
        SELECT * FROM "Payment" WHERE "provider" = ${this.provider.name}::"PaymentProvider"
          AND "reference" = ${event.reference} FOR UPDATE
      `);
        const payment = rows[0];
        if (!payment) throw new NotFoundException('Unknown provider reference');
        if (
          payment.amountMinor.toString() !== event.amountMinor ||
          payment.currency !== event.currency
        ) {
          throw new ConflictException('Provider amount or currency does not match payment intent');
        }
        const existing = await tx.providerEvent.findUnique({
          where: { provider_eventId: { provider: this.provider.name, eventId: event.eventId } },
        });
        if (existing) {
          if (existing.payloadHash !== event.payloadHash || existing.paymentId !== payment.id)
            throw new ConflictException('Provider event identity was reused');
          return { received: true, paymentId: payment.id, status: payment.status };
        }
        if (payment.status !== 'PENDING' && payment.status !== event.status)
          throw new ConflictException('Conflicting terminal provider outcome');
        await tx.$queryRaw`SELECT set_config('app.payment_write', 'on', true)`;
        await tx.providerEvent.create({
          data: {
            provider: this.provider.name,
            paymentId: payment.id,
            eventId: event.eventId,
            payloadHash: event.payloadHash,
            status: event.status,
          },
        });
        if (payment.status !== 'PENDING')
          return { received: true, paymentId: payment.id, status: payment.status };

        let ledgerTransactionId: string | undefined;
        if (event.status === 'SUCCEEDED') {
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: payment.walletId } });
          const clearing = await tx.ledgerAccount.findUniqueOrThrow({
            where: { systemKey: externalClearingAccountKey(payment.currency) },
          });
          const ledger = await this.ledger.postWithinTransaction(tx, {
            reference: payment.reference,
            currency: payment.currency,
            description: 'Verified mock provider funding',
            postings: [
              { accountId: clearing.id, amountMinor: -payment.amountMinor },
              { accountId: wallet.ledgerAccountId, amountMinor: payment.amountMinor },
            ],
          });
          ledgerTransactionId = ledger.id;
        }
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: event.status, completedAt: new Date(), ledgerTransactionId },
        });
        await tx.outboxEvent.create({
          data: {
            type: event.status === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
            aggregateType: 'Payment',
            aggregateId: payment.id,
            actorUserId: payment.userId,
            payload: {
              paymentId: payment.id,
              reference: payment.reference,
              provider: payment.provider,
              walletId: payment.walletId,
              amountMinor: payment.amountMinor.toString(),
              currency: payment.currency,
            },
          },
        });
        return { received: true, paymentId: payment.id, status: event.status };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 10000,
      },
    );
  }
}
