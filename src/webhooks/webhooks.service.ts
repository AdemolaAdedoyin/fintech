import { Injectable, NotFoundException } from '@nestjs/common';
import { WebhookSigningService } from '../async/webhook-signing.service';
import { WebhookTargetService } from '../async/webhook-target.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
    private readonly targets: WebhookTargetService,
  ) {}

  async createEndpoint(userId: string, input: CreateWebhookEndpointDto) {
    const url = this.targets.normalizeAndValidateUrl(input.url);
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        userId,
        url,
        ...(input.description ? { description: input.description.trim() } : {}),
      },
    });

    return {
      ...this.toEndpointResponse(endpoint),
      signingSecret: this.signing.deriveEndpointSecret(endpoint.id),
    };
  }

  async findEndpoints(userId: string) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });

    return endpoints.map((endpoint) => this.toEndpointResponse(endpoint));
  }

  async disableEndpoint(userId: string, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, userId },
    });

    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }

    if (!endpoint.enabled) {
      return this.toEndpointResponse(endpoint);
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { enabled: false },
    });

    return this.toEndpointResponse(updated);
  }

  async findDeliveries(userId: string) {
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpoint: { userId } },
      include: {
        endpoint: { select: { id: true, url: true } },
        outboxEvent: { select: { eventType: true, occurredAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });

    return deliveries.map((delivery) => ({
      id: delivery.id,
      endpointId: delivery.endpoint.id,
      endpointUrl: delivery.endpoint.url,
      eventType: delivery.outboxEvent.eventType,
      occurredAt: delivery.outboxEvent.occurredAt,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      responseStatus: delivery.responseStatus,
      lastError: delivery.lastError,
      deliveredAt: delivery.deliveredAt,
      createdAt: delivery.createdAt,
    }));
  }

  private toEndpointResponse(endpoint: {
    id: string;
    url: string;
    description: string | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description,
      enabled: endpoint.enabled,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }
}
