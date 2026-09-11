import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('endpoints')
  @ApiOperation({
    summary: 'Register an HTTPS webhook endpoint and return its signing secret once',
  })
  createEndpoint(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateWebhookEndpointDto,
  ) {
    return this.webhooks.createEndpoint(user.id, input);
  }

  @Get('endpoints')
  @ApiOperation({ summary: 'List webhook endpoints owned by the authenticated user' })
  findEndpoints(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.findEndpoints(user.id);
  }

  @Delete('endpoints/:endpointId')
  @ApiOperation({ summary: 'Disable an owned webhook endpoint without deleting delivery history' })
  disableEndpoint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('endpointId', new ParseUUIDPipe()) endpointId: string,
  ) {
    return this.webhooks.disableEndpoint(user.id, endpointId);
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'List recent webhook delivery attempts for owned endpoints' })
  findDeliveries(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.findDeliveries(user.id);
  }
}
