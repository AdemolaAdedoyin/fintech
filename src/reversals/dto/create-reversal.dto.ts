import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateReversalDto {
  @ApiPropertyOptional({
    example: 'Duplicate payment',
    minLength: 1,
    maxLength: 255,
    description: 'Optional reason retained with the immutable reversal record',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(1, 255)
  reason?: string;
}
