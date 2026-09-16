import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePaymentDto, ListPaymentsDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create a mock-provider funding intent; does not credit the wallet' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreatePaymentDto,
  ) {
    return this.payments.create(user.id, key, input);
  }
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPaymentsDto) {
    return this.payments.list(user.id, query);
  }
  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.findOne(user.id, id);
  }
  @Get(':id/events')
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListPaymentsDto,
  ) {
    return this.payments.events(user.id, id, query);
  }
}

@ApiTags('provider-callbacks')
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('mock')
  @HttpCode(200)
  @ApiHeader({ name: 'Mock-Timestamp', required: true })
  @ApiHeader({ name: 'Mock-Signature', required: true })
  @ApiOperation({ summary: 'Accept a signed mock-provider callback (development/test only)' })
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('mock-timestamp') timestamp: string | undefined,
    @Headers('mock-signature') signature: string | undefined,
  ) {
    return this.payments.receive(request.rawBody ?? Buffer.alloc(0), timestamp, signature);
  }
}
