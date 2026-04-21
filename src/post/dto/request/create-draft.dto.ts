import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsArray, IsDateString, IsUUID } from 'class-validator';

export class CreateDraftDto {
  @ApiPropertyOptional({
    description: 'The main text content of the post. Can be empty for early drafts.',
    example: 'Excited to announce our new feature...',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'List of destination IDs (e.g., social media account IDs) to publish to. Can be omitted if the user has not selected platforms yet.',
    example: ['uuid-for-twitter', 'uuid-for-linkedin'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  destinations?: string[];

  @ApiPropertyOptional({
    description: 'When the post is intended to go live, in ISO-8601 format. Optional for drafts.',
    example: '2026-05-01T10:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description: 'Optional reference to an AI generation job used to create this content.',
    example: 'uuid-for-ai-generation',
  })
  @IsOptional()
  @IsUUID()
  aiGenerationId?: string;

  @ApiPropertyOptional({
    description: 'Any attached media URLs (images, videos).',
    example: ['https://storage.example.com/image1.png'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaUrls?: string[];
}