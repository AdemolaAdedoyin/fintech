import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateTransferDto {
  @ApiProperty({ format: 'uuid', description: 'Source wallet identifier' })
  @IsUUID('4')
  sourceWalletId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Direct destination identifier; mutually exclusive with beneficiaryId',
  })
  @IsOptional()
  @IsUUID('4')
  destinationWalletId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Saved beneficiary identifier; mutually exclusive with destinationWalletId',
  })
  @IsOptional()
  @IsUUID('4')
  beneficiaryId?: string;

  @ApiProperty({
    example: '2500',
    description: 'Positive amount in minor units encoded as a decimal string',
  })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/, {
    message: 'amountMinor must be a positive integer string in minor units',
  })
  amountMinor!: string;
}
