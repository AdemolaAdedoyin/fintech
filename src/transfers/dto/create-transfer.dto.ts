import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateTransferDto {
  @IsUUID('4')
  sourceWalletId!: string;

  @IsOptional()
  @IsUUID('4')
  destinationWalletId?: string;

  @IsOptional()
  @IsUUID('4')
  beneficiaryId?: string;

  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d*$/, {
    message: 'amountMinor must be a positive integer string in minor units',
  })
  amountMinor!: string;
}
