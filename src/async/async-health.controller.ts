import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AsyncRuntimeService } from './async-runtime.service';

@ApiTags('health')
@Controller('health')
export class AsyncHealthController {
  constructor(private readonly runtime: AsyncRuntimeService) {}

  @Get('async')
  @ApiOperation({ summary: 'Check Redis/BullMQ connectivity without gating database readiness' })
  async asyncHealth() {
    try {
      const result = await this.runtime.ping();
      return { status: 'ok', redis: result };
    } catch {
      throw new ServiceUnavailableException('Async infrastructure is unavailable');
    }
  }
}
