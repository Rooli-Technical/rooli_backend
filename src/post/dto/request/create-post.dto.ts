import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentType } from '@generated/enums';
import { Type } from 'class-transformer';
import { PostOverrideDto } from './post-override.dto';
import { ThreadItemDto } from './thread-item.dto';

export class CreatePostDto {
  @ApiProperty({
    description: 'Text content of the post',
    example: 'Launching our new product today 🚀',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'Type of content being posted',
    enum: ContentType,
    default: ContentType.POST,
  })
  @IsOptional()
  @IsEnum(ContentType)
  contentType?: ContentType = ContentType.POST;

  @ApiProperty({
    description: 'List of SocialProfile IDs this post should be published to',
    example: ['cl9abc123facebook_page_id', 'cl9xyz456linkedin_profile_id'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  socialProfileIds: string[];

  @ApiPropertyOptional({
    description:
      'Media IDs from Media Library (Cloudinary). Order determines carousel order.',
    example: ['media_1', 'media_2'],
    type: [String],
    default: [],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[] = [];

  @ApiPropertyOptional({
    description:
      'ISO 8601 datetime string for when the post should be published',
    example: '2026-01-10T09:00:00.000',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description:
      'Whether the system should automatically determine the best posting time',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isAutoSchedule?: boolean;

  @ApiProperty({
    description: 'IANA timezone used for scheduling',
    example: 'Africa/Lagos',
    default: 'UTC',
  })
  @IsNotEmpty()
  @IsString()
  timezone: string = 'UTC';

  @ApiPropertyOptional({
    description: 'Campaign ID (Rocket plan feature) for grouping posts',
    example: 'cmp_123456',
  })
  @IsOptional()
  @IsString()
  campaignId?: string;

  @ApiPropertyOptional({
    description: 'Label IDs used for categorizing the post',
    example: ['lbl_marketing', 'lbl_launch'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({
    description: 'Whether the post requires approval before publishing',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  needsApproval?: boolean;

  @ApiPropertyOptional({
    type: () => [PostOverrideDto],
    example: [
      {
        socialProfileId: 'profile_twitter_123',
        content: 'Twitter version with hashtags #dev #nestjs',
      },
      {
        socialProfileId: 'profile_linkedin_456',
        content: 'LinkedIn version with a professional tone.',
      },
    ],
    description: 'Optional platform-specific content overrides',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PostOverrideDto)
  @IsOptional()
  overrides?: PostOverrideDto[];

  @ApiPropertyOptional({
    type: () => [ThreadItemDto],
    example: [
      {
        content: 'Thread reply #1 with extra insight',
        mediaIds: ['media_img_1'],
        targetProfileIds: ['profile_twitter_123'],
      },
      {
        content: 'Thread reply #2 (general)',
      },
    ],
    description: 'Optional thread replies attached to the main post',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ThreadItemDto)
  @IsOptional()
  threads?: ThreadItemDto[];

  @ApiPropertyOptional({
    description:
      'ID of the AI generation that created this post (if applicable)',
    example: 'gen_1234567890',
  })
  @IsOptional()
  @IsString()
  aiGenerationId?: string;
}
