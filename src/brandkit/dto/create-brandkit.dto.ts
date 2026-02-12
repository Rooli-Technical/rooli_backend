import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

class ColorsDto {
  @ApiPropertyOptional({ example: '#1E40AF' })
  @IsOptional()
  @IsString()
  primary?: string;

  @ApiPropertyOptional({ example: '#F59E0B' })
  @IsOptional()
  @IsString()
  secondary?: string;

  @ApiPropertyOptional({ example: '#22C55E' })
  @IsOptional()
  @IsString()
  accent?: string;
}

class GuidelinesDto {
  @ApiPropertyOptional({ example: ['Use short sentences', 'Write for founders'] })
  @IsOptional()
  do?: string[];

  @ApiPropertyOptional({ example: ['No slang', 'Avoid politics'] })
  @IsOptional()
  dont?: string[];

  @ApiPropertyOptional({ example: ['Rooli', 'Scheduling'] })
  @IsOptional()
  keywords?: string[];

  @ApiPropertyOptional({ example: ['cheap', 'guaranteed'] })
  @IsOptional()
  bannedWords?: string[];

  @ApiPropertyOptional({ enum: ['NONE', 'LIGHT', 'HEAVY'], example: 'LIGHT' })
  @IsOptional()
  @IsString()
  emojiStyle?: 'NONE' | 'LIGHT' | 'HEAVY';

  @ApiPropertyOptional({ enum: ['NONE', 'QUESTION', 'DIRECT', 'SOFT'], example: 'QUESTION' })
  @IsOptional()
  @IsString()
  ctaStyle?: 'NONE' | 'QUESTION' | 'DIRECT' | 'SOFT';

  @ApiPropertyOptional({ enum: ['SHORT_LINES', 'PARAGRAPHS', 'BULLETS'], example: 'SHORT_LINES' })
  @IsOptional()
  @IsString()
  formatting?: 'SHORT_LINES' | 'PARAGRAPHS' | 'BULLETS';

  @ApiPropertyOptional({ enum: ['ALLOW', 'DISALLOW', 'ALLOW_WITH_UTM'], example: 'ALLOW' })
  @IsOptional()
  @IsString()
  linkPolicy?: 'ALLOW' | 'DISALLOW' | 'ALLOW_WITH_UTM';
}

export class CreateBrandKitDto {
  @ApiPropertyOptional({ example: 'Our Brand' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'cm1abc123...' })
  @IsOptional()
  @IsString()
  logoId?: string;

  @ApiPropertyOptional({ type: ColorsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ColorsDto)
  colors?: ColorsDto;

  @ApiPropertyOptional({ example: 'We sound like a sharp, friendly founder.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  brandVoice?: string;

  @ApiPropertyOptional({ example: 'Professional but witty' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tone?: string;

  @ApiPropertyOptional({ type: GuidelinesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GuidelinesDto)
  guidelines?: GuidelinesDto;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

