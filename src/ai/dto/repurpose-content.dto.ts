import { Platform } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class RepurposeContentDto {
  @ApiPropertyOptional({ 
    example: 'https://example.com/blog-post', 
    description: 'The URL to scrape content from' 
  })
  @IsOptional()
  @IsUrl()
  sourceUrl?: string;

  @ApiPropertyOptional({ 
    example: 'Here is a long text about social media marketing...', 
    description: 'Raw text to be repurposed if no URL is provided' 
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sourceText?: string;

  @ApiProperty({ 
    enum: Platform, 
    example: Platform.LINKEDIN,
    description: 'The target platform style for the repurposed content'
  })
  @IsEnum(Platform)
  @IsNotEmpty()
  targetPlatform: Platform;

  @ApiPropertyOptional({ 
    description: 'Specific Brand Kit ID to use for tone and guidelines' 
  })
  @IsOptional()
  @IsString()
  brandKitId?: string;
}