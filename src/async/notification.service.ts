import { Injectable } from '@nestjs/common';
import { NotificationType, OutboxEventType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async persistForEvent(eventId: string) {
    const event = await this.prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    const content = this.content(event.type, event.aggregateId);

    return this.prisma.notification.upsert({
      where: { outboxEventId: event.id },
      create: {
        outboxEventId: event.id,
        userId: event.actorUserId,
        type: content.type,
        subject: content.subject,
        body: content.body,
      },
      update: {},
    });
  }

  private content(type: OutboxEventType, aggregateId: string) {
    if (type === OutboxEventType.TRANSFER_COMPLETED) {
      return {
        type: NotificationType.TRANSFER_COMPLETED,
        subject: 'Transfer completed',
        body: `Your transfer ${aggregateId} completed successfully.`,
      };
    }

    return {
      type: NotificationType.TRANSFER_REVERSED,
      subject: 'Transfer reversed',
      body: `Your transfer reversal ${aggregateId} completed successfully.`,
    };
  }
}
