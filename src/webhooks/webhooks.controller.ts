import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateWebhookDto, ListDeliveriesDto } from './webhooks.dto';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebhookDto) {
    return this.webhooks.create(user.id, dto.url);
  }
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.list(user.id);
  }
  @Delete(':id')
  @HttpCode(204)
  disable(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.disable(user.id, id);
  }
  @Get(':id/deliveries')
  deliveries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListDeliveriesDto,
  ) {
    return this.webhooks.deliveries(user.id, id, query);
  }
}
