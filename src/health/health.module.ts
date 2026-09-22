import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}
