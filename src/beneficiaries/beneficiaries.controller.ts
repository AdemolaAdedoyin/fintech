import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BeneficiariesService } from './beneficiaries.service';
import { CreateBeneficiaryDto } from './dto/create-beneficiary.dto';

@ApiTags('beneficiaries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiariesService: BeneficiariesService) {}

  @Post()
  @ApiOperation({ summary: 'Save another user wallet as a beneficiary' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateBeneficiaryDto) {
    return this.beneficiariesService.create(user.id, input.walletId, input.label);
  }

  @Get()
  @ApiOperation({ summary: 'List active beneficiaries owned by the authenticated user' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.beneficiariesService.findAll(user.id);
  }

  @Delete(':beneficiaryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a beneficiary without deleting transfer history' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('beneficiaryId', new ParseUUIDPipe()) beneficiaryId: string,
  ): Promise<void> {
    await this.beneficiariesService.remove(user.id, beneficiaryId);
  }
}
