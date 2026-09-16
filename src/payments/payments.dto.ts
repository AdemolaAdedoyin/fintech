import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty()
  @IsUUID()
  walletId!: string;

  @ApiProperty({
    example: '2500',
    description: 'Positive integer minor units; wallet determines currency',
  })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9][0-9]*$/)
  amountMinor!: string;
}

export class ListPaymentsDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
