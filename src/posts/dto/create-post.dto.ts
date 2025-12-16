import { Platform, ContentType } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsString, IsOptional, IsArray, IsEnum, IsNotEmpty } from 'class-validator';

export class CreatePostDto {
  @ApiProperty({ description: 'Social account to publish under' })
  @IsNotEmpty()
  @IsString()
  socialAccountId: string;

  @ApiPropertyOptional({ description: 'Social account to publish under' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ description: 'Page account to publish under' })
  @IsOptional()
  @IsString()
  pageAccountId?: string;

  @ApiProperty({ description: 'Main content of the post' })
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({
    description: 'Media file IDs already uploaded',
    required: false,
  })
  @IsOptional()
  @IsArray()
  mediaFileIds?: string[];

  @ApiProperty({
    description: 'AI content ID if generated via AI',
    required: false,
  })
  @IsOptional()
  @IsString()
  aiContentId?: string;
  @ApiProperty({
    enum: Platform,
    description: 'Platform to publish on',
    example: Platform.FACEBOOK,
  })
  @IsEnum(Platform)
  platform: Platform;

  @ApiProperty({
    enum: ContentType,
    description: 'Content type (text, image, video, etc.)',
    example: ContentType.POST,
  })
  @IsEnum(ContentType)
  contentType: ContentType;

  @ApiProperty({
    description: 'Extra metadata like hashtags, mentions',
    required: false,
  })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiProperty({
    description: 'Scheduled time for the post',
    required: false,
    example: '2025-10-21T14:30:00.000',
  })
  @IsOptional()
  scheduledAt?: string;
}
