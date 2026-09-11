import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  @ApiOperation({ summary: 'Create another wallet in a supported currency' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateWalletDto) {
    return this.walletsService.create(user.id, input.currency);
  }

  @Get()
  @ApiOperation({ summary: 'List wallets owned by the authenticated user' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.walletsService.findAllForUser(user.id);
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get one owned wallet' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ) {
    return this.walletsService.findOneForUser(user.id, walletId);
  }

  @Post(':walletId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an owned zero-balance wallet' })
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ) {
    return this.walletsService.close(user.id, walletId);
  }
}
