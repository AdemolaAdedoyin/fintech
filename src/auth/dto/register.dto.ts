import { Currency } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';

function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeEmail({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export class RegisterDto {
  @ApiProperty({ example: 'alex@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 12, example: 'correct-horse-battery-staple' })
  @IsString()
  @Length(12, 256)
  password!: string;

  @ApiProperty({ example: 'Alex' })
  @Transform(trimString)
  @IsString()
  @Length(1, 80)
  firstName!: string;

  @ApiProperty({ example: 'Morgan' })
  @Transform(trimString)
  @IsString()
  @Length(1, 80)
  lastName!: string;

  @ApiPropertyOptional({ enum: Currency, default: Currency.USD })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;
}
