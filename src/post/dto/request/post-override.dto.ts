import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export enum TikTokPrivacyLevel {
  PUBLIC_TO_EVERYONE = 'PUBLIC_TO_EVERYONE',
  MUTUAL_FOLLOW_FRIENDS = 'MUTUAL_FOLLOW_FRIENDS',
  FOLLOWER_OF_CREATOR = 'FOLLOWER_OF_CREATOR',
  SELF_ONLY = 'SELF_ONLY',
}

export class TikTokOptionsDto {
  @ApiPropertyOptional({
    enum: TikTokPrivacyLevel,
    description:
      'Visibility of the post on TikTok. Must be one of the values returned by the creator info query for this account.',
  })
  @IsOptional()
  @IsEnum(TikTokPrivacyLevel)
  privacyLevel?: TikTokPrivacyLevel;

  @ApiPropertyOptional({ description: 'Disable comments on the post.' })
  @IsOptional()
  @IsBoolean()
  disableComment?: boolean;

  @ApiPropertyOptional({ description: 'Disable Duet on the video.' })
  @IsOptional()
  @IsBoolean()
  disableDuet?: boolean;

  @ApiPropertyOptional({ description: 'Disable Stitch on the video.' })
  @IsOptional()
  @IsBoolean()
  disableStitch?: boolean;

  @ApiPropertyOptional({
    description: 'Timestamp (ms) within the video to use as the cover frame.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  videoCoverTimestampMs?: number;

  @ApiPropertyOptional({
    description: 'Mark this post as a paid partnership / branded content.',
  })
  @IsOptional()
  @IsBoolean()
  brandContentToggle?: boolean;

  @ApiPropertyOptional({
    description: "Mark this post as promoting the creator's own brand.",
  })
  @IsOptional()
  @IsBoolean()
  brandOrganicToggle?: boolean;
}

export class PostOverrideDto {
  @ApiProperty({
    example: 'profile_twitter_123',
    description: 'Social profile ID this override applies to',
  })
  @IsNotEmpty()
  @IsString()
  socialProfileId: string;

  @ApiPropertyOptional({
    example: 'Launching today 🚀 #startup #buildinpublic',
    description:
      'Customized content for the specific social profile. If omitted, the master post content is used.',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    type: () => TikTokOptionsDto,
    description:
      'TikTok-specific publishing options (privacy level, interaction toggles, etc.). Only applies when the target profile is a TikTok account.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TikTokOptionsDto)
  tiktok?: TikTokOptionsDto;
}
