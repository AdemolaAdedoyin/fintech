import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(userId: string) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });

    return notifications.map((notification) => ({
      id: notification.id,
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    }));
  }

  async markRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.readAt) {
      return {
        id: notification.id,
        eventType: notification.eventType,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt,
        readAt: notification.readAt,
      };
    }

    const updated = await this.prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: new Date() },
    });

    return {
      id: updated.id,
      eventType: updated.eventType,
      title: updated.title,
      body: updated.body,
      createdAt: updated.createdAt,
      readAt: updated.readAt,
    };
  }
}
