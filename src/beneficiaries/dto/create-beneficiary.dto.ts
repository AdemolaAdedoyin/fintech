import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length } from 'class-validator';

export class CreateBeneficiaryDto {
  @ApiProperty({ format: 'uuid', description: 'Wallet identifier to save as a beneficiary' })
  @IsUUID('4')
  walletId!: string;

  @ApiProperty({ example: 'Primary recipient', minLength: 1, maxLength: 80 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  label!: string;
}
