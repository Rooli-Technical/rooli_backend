import { Platform } from "@generated/enums";
import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsEnum, IsISO8601, IsInt, Min, Max, IsArray, ArrayMinSize, IsString } from "class-validator";

export class AutoScheduleDto {
  @ApiPropertyOptional({
    description: 'Optional platform filter (if scheduling is platform-specific).',
    enum: Platform,
    example: 'INSTAGRAM',
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    description:
      'Start scheduling from this ISO-8601 time. If omitted, uses now.',
    example: '2026-02-10T16:00:00+01:00',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'How many days to look ahead for available slots.',
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

  @ApiProperty({
    description: 'List of post IDs (drafts) to schedule into the queue.',
    example: ['post_1', 'post_2', 'post_3'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  postIds: string[];

  @ApiPropertyOptional({
    description:
      'Optional minimum spacing (in minutes) between scheduled posts (helps avoid clumping).',
    example: 30,
    minimum: 0,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  minSpacingMinutes?: number;
}