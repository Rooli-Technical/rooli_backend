import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsArray, IsOptional } from 'class-validator';

export class ThreadItemDto {
  @ApiProperty({
    example: 'Here is a follow-up with more context 👇',
    description: 'Text content of the thread reply',
  })
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiPropertyOptional({
    example: ['media_img_1', 'media_img_2'],
    description: 'Optional media IDs attached to this thread item',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];

  @ApiPropertyOptional({
    example: ['profile_twitter_123'],
    description:
      'If set, this thread item is posted only to these social profiles',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  targetProfileIds?: string[];
}
