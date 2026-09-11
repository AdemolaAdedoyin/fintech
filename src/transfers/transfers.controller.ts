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
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable client-generated key used to make transfer retries safe',
  })
  @ApiOperation({ summary: 'Move money between two active same-currency wallets' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateTransferDto,
  ) {
    return this.transfersService.create(user.id, idempotencyKey, input);
  }

  @Get()
  @ApiOperation({ summary: 'List transfers initiated by the authenticated user' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.transfersService.findAllForUser(user.id);
  }

  @Get(':transferId')
  @ApiOperation({ summary: 'Get one transfer initiated by the authenticated user' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
  ) {
    return this.transfersService.findOneForUser(user.id, transferId);
  }
}
