import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export type CalendarInclude = 'posts' | 'campaigns' | 'holidays';

export class GetCalendarQueryDto {
  @ApiProperty({
    description: 'Start of range (YYYY-MM-DD). Use day boundaries in workspace timezone.',
    example: '2026-02-01',
  })
  @IsNotEmpty()
  @IsString()
  from: string;

  @ApiProperty({
    description: 'End of range (YYYY-MM-DD). Usually first day of next month.',
    example: '2026-03-01',
  })
   @IsNotEmpty()
  @IsString()
  to: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated include list. Defaults to posts,campaigns,holidays.',
    example: 'posts,campaigns,holidays',
  })
  @IsOptional()
  @IsString()
  include?: string;

  @ApiPropertyOptional({
    description:
      'Country code for public holidays (ISO 3166-1 alpha-2). Example: NG, US, GB.',
    example: 'NG',
  })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({
    description:
      'Optional region/state code (depends on library support). Example: LA (Nigeria Lagos) or CA (US California).',
    example: 'LA',
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({
    description:
      'Optional locale for holiday names if supported. Example: en, fr.',
    example: 'en',
  })
  @IsOptional()
  @IsString()
  lang?: string;

  @ApiPropertyOptional({
    description:
      'If true, include draft posts (unscheduled) as floating events (usually false).',
    example: 'false',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeDrafts?: 'true' | 'false';

  @ApiPropertyOptional({
    description:
      'If set, only return posts for a platform (LINKEDIN/X/FACEBOOK/INSTAGRAM).',
    example: 'LINKEDIN',
  })
  @IsOptional()
  @IsString()
  platform?: string;
}