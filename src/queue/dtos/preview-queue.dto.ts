import { Platform } from "@generated/enums";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum, IsISO8601, IsInt, Min, Max } from "class-validator";

export class PreviewQueueDto {
  @ApiPropertyOptional({
    description: 'Optional platform filter (if your slots are platform-specific).',
    enum: Platform,
    example: 'LINKEDIN',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    description:
      'Starting point for preview in ISO-8601. If omitted, uses current time. Optionally specify a "from" time to find the next slot after that time instead of now.',
    example: '2026-02-10T16:00:00+01:00',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'How many days to look ahead. The preview will include all slots in the next N days.',
    example: 30,
    minimum: 1,
    maximum: 90,
    default: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({
    description: 'How many upcoming slot times to return. Optional',
    example: 10,
    minimum: 1,
    maximum: 50,
    default: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  count?: number;
}