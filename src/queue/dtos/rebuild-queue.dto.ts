import { Platform } from "@generated/enums";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum, IsISO8601, IsInt, Min, Max, IsArray } from "class-validator";

export enum PostStatusForQueue {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
}

export class RebuildQueueDto {
  @ApiPropertyOptional({
    description: 'Optional platform filter.',
    enum: Platform,
    example: 'FACEBOOK',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    description:
      'Start point for rebuild in ISO-8601. If omitted, uses now.',
    example: '2026-02-10T16:00:00+01:00',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'How many days ahead to rebuild.',
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
    description:
      'Which statuses are eligible for rebuild. Defaults to [DRAFT, QUEUED].',
    enum: PostStatusForQueue,
    isArray: true,
    example: ['DRAFT', 'QUEUED'],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(PostStatusForQueue, { each: true })
  statuses?: PostStatusForQueue[];
}