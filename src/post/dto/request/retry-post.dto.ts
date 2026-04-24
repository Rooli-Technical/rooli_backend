import { ApiPropertyOptional } from '@nestjs/swagger';
import { 
  IsOptional, 
  IsString, 
  IsArray, 
  IsBoolean, 
  IsISO8601 
} from 'class-validator';

export class RetryPostDto {
  @ApiPropertyOptional({
    description: 'Override the text content of the failed post.',
    example: 'Let us try this again! 🚀',
  })
  @IsOptional()
  @IsString()
  contentOverride?: string;

  @ApiPropertyOptional({
    description: 'Provide a new array of mediaFileIds if the original media was the cause of the failure.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({
    description: 'A specific ISO-8601 datetime to schedule the retry. If omitted and isAutoSchedule is false, it schedules for immediately.',
    example: '2026-05-01T14:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description: 'If true, ignores scheduledAt and uses the next available queue slot.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isAutoSchedule?: boolean;

  @ApiPropertyOptional({
    description: 'The timezone of the user, required if scheduledAt is a local time string without an offset.',
    example: 'Africa/Lagos',
  })
  @IsOptional()
  @IsString()
  timezone?: string;
}