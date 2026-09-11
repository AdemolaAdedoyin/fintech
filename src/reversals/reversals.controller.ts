import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateReversalDto } from './dto/create-reversal.dto';
import { ReversalsService } from './reversals.service';

@ApiTags('reversals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class ReversalsController {
  constructor(private readonly reversalsService: ReversalsService) {}

  @Post(':transferId/reversal')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable client-generated key used to make reversal retries safe',
  })
  @ApiOperation({ summary: 'Create one full compensating reversal for an owned transfer' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateReversalDto,
  ) {
    return this.reversalsService.create(user.id, transferId, idempotencyKey, input);
  }

  @Get(':transferId/reversal')
  @ApiOperation({ summary: 'Get the reversal for an owned transfer' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
  ) {
    return this.reversalsService.findOneForUser(user.id, transferId);
  }
}
