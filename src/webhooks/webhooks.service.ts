import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookTransportError, WebhookTransportService } from './webhook-transport.service';
import type { ListDeliveriesDto } from './webhooks.dto';

const publicSubscription = { id: true, url: true, enabled: true, createdAt: true } as const;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: WebhookCryptoService,
    private readonly transport: WebhookTransportService,
  ) {}

  async create(userId: string, url: string) {
    if (!this.crypto.enabled)
      throw new ServiceUnavailableException('Webhook signing is unavailable');
    try {
      await this.transport.validate(url);
    } catch (error) {
      if (error instanceof WebhookTransportError && error.code === 'UNSAFE_ENDPOINT') {
        throw new BadRequestException('A public HTTPS endpoint on port 443 is required');
      }
      throw new ServiceUnavailableException('Endpoint DNS validation failed');
    }
    const secret = this.crypto.generate();
    const subscription = await this.prisma.webhookSubscription.create({
      data: { userId, url, encryptedSecret: this.crypto.encrypt(secret) },
      select: publicSubscription,
    });
    return { ...subscription, secret };
  }

  list(userId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { userId },
      select: publicSubscription,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async disable(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.webhookSubscription.updateMany({
        where: { id, userId },
        data: { enabled: false },
      });
      if (!changed.count) throw new NotFoundException('Webhook not found');
      await tx.webhookDelivery.updateMany({
        where: { subscriptionId: id, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'CANCELLED', leaseUntil: null, leaseToken: null },
      });
      await tx.webhookAttempt.updateMany({
        where: { delivery: { subscriptionId: id }, status: { in: ['QUEUED', 'SENDING'] } },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
    });
  }

  async deliveries(userId: string, id: string, query: ListDeliveriesDto) {
    if (
      !(await this.prisma.webhookSubscription.findFirst({
        where: { id, userId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Webhook not found');
    }
    if (
      query.cursor &&
      !(await this.prisma.webhookDelivery.findFirst({
        where: { id: query.cursor, subscriptionId: id },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException('Invalid delivery cursor');
    }
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { subscriptionId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        outboxEventId: true,
        status: true,
        attemptCount: true,
        createdAt: true,
        availableAt: true,
        attempts: {
          orderBy: { number: 'asc' },
          select: {
            number: true,
            status: true,
            httpStatus: true,
            errorCode: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });
    const more = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: more ? items.at(-1)!.id : null };
  }
}
