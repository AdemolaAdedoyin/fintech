import { Global, Module } from '@nestjs/common';
import { OperationalRedis } from './redis.service';
@Global()
@Module({ providers: [OperationalRedis], exports: [OperationalRedis] })
export class OperationsModule {}
