import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isIP } from 'node:net';
import { WebhookSigningService } from '../async/webhook-signing.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
  ) {}

  async createEndpoint(userId: string, input: CreateWebhookEndpointDto) {
    const url = this.normalizeAndValidateUrl(input.url);
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

  private normalizeAndValidateUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Webhook URL must be a valid absolute HTTPS URL');
    }

    if (url.protocol !== 'https:') {
      throw new BadRequestException('Webhook URL must use HTTPS');
    }

    if (url.username || url.password) {
      throw new BadRequestException('Webhook URL must not include credentials');
    }

    if (url.hash) {
      throw new BadRequestException('Webhook URL must not include a fragment');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      throw new BadRequestException('Webhook URL must use a public hostname');
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && this.isPrivateIpv4(hostname)) {
      throw new BadRequestException('Webhook URL must not target a private IPv4 address');
    }

    if (ipVersion === 6 && this.isPrivateIpv6(hostname)) {
      throw new BadRequestException('Webhook URL must not target a private IPv6 address');
    }

    return url.toString();
  }

  private isPrivateIpv4(hostname: string): boolean {
    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true;

    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  private isPrivateIpv6(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
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
