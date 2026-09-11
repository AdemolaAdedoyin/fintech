import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

export class CreateWebhookEndpointDto {
  @ApiProperty({
    example: 'https://example.com/hooks/fintech',
    maxLength: 2048,
    description: 'HTTPS callback URL that will receive signed domain-event deliveries',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @ApiPropertyOptional({
    example: 'Portfolio demo receiver',
    minLength: 1,
    maxLength: 120,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(1, 120)
  description?: string;
}
