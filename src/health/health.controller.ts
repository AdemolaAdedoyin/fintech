import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OperationalRedis } from '../operations/redis.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: OperationalRedis,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness check' })
  liveness() {
    return {
      status: 'ok',
      service: 'fintech-transaction-platform',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'PostgreSQL and Redis readiness check' })
  async readiness() {
    try {
      await Promise.all([this.prisma.$queryRaw`SELECT 1`, this.redis.client.ping()]);

      return {
        status: 'ok',
        database: 'up',
        redis: 'up',
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        dependencies: 'unavailable',
      });
    }
  }

  @Get()
  @ApiOperation({ summary: 'Service health check' })
  async health() {
    return this.readiness();
  }
}
