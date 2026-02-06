
import { Platform } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GenerateCaptionDto {
  @ApiProperty({ example: 'Announce our early access launch' })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({ example: 'Professional but witty' })
  @IsOptional()
  @IsString()
  tone?: string;

  @ApiPropertyOptional({ example: 'ckit_123' })
  @IsOptional()
  @IsString()
  brandKitId?: string;

  @ApiPropertyOptional({ example: 'LINKEDIN', enum: ['LINKEDIN','INSTAGRAM','FACEBOOK','X'] })
  @IsOptional()
  @IsEnum(['LINKEDIN','INSTAGRAM','FACEBOOK','X'] as any)
  platform?: Platform;

  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(500)
  maxChars?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  saveAsDraftPost?: boolean;
}
