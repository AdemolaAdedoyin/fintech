import {
  Controller,
  Get,
  Headers,
  Header,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OperationalRedis } from '../operations/redis.service';

@ApiExcludeController()
@Controller('health')
export class MetricsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: OperationalRedis,
    private readonly config: ConfigService,
  ) {}
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  @Header('Cache-Control', 'no-store')
  async metrics(@Headers('authorization') authorization: string | undefined) {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) throw new ServiceUnavailableException('Metrics are disabled');
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!authorization || !timingSafeEqual(hash(authorization), hash(`Bearer ${token}`)))
      throw new UnauthorizedException();
    try {
      const [pending, failed, payments, heartbeat, missing] = await Promise.all([
        this.prisma.outboxEvent.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
        this.prisma.webhookDelivery.count({ where: { status: 'FAILED' } }),
        this.prisma.payment.count({ where: { status: 'PENDING' } }),
        this.redis.client.get('fintech:worker:last-poll'),
        this.prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM "OutboxEvent" e LEFT JOIN "Notification" n ON n."outboxEventId" = e.id WHERE n.id IS NULL`,
      ]);
      const age = heartbeat ? Math.max(0, (Date.now() - Number(heartbeat)) / 1000) : -1;
      return `# TYPE fintech_outbox_pending gauge\nfintech_outbox_pending ${pending}\n# TYPE fintech_webhook_failed gauge\nfintech_webhook_failed ${failed}\n# TYPE fintech_payment_pending gauge\nfintech_payment_pending ${payments}\n# TYPE fintech_worker_poll_age_seconds gauge\nfintech_worker_poll_age_seconds ${Number.isFinite(age) ? age : -1}\n# TYPE fintech_notification_unpersisted gauge\nfintech_notification_unpersisted ${missing[0]?.count ?? 0n}\n# TYPE fintech_process_uptime_seconds gauge\nfintech_process_uptime_seconds ${process.uptime()}\n`;
    } catch {
      throw new ServiceUnavailableException('Metrics dependencies unavailable');
    }
  }
}
