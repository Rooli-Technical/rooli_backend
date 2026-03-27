import { IsEnum, IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Platform } from '@generated/enums';

export class GetAnalyticsDto {
  @ApiProperty({
    description: 'The ID of the social profile to fetch stats for',
    example: 'cm6f1234...',
  })
  @IsUUID()
  socialProfileId: string;

  @ApiProperty({ enum: Platform })
  @IsEnum(Platform)
  platform: Platform;

  @ApiPropertyOptional({
    description: 'Start date (ISO 8601)',
    example: '2026-01-01',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date (ISO 8601)',
    example: '2026-01-31',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}
