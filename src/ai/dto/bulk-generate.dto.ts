import { Platform } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class BulkGenerateDto {
  @ApiProperty({ 
    example: 'The future of AI in 2026', 
    description: 'The core topic or theme for the batch of posts' 
  })
  @IsString()
  @IsNotEmpty()
  topic: string;

  @ApiProperty({ 
    example: 10, 
    description: 'Number of posts to generate in this batch (Max 30 for Rocket)' 
  })
  @IsInt()
  @Min(1)
  @Max(30)
  count: number;

  @ApiProperty({ 
    enum: Platform, 
    isArray: true, 
    example: [Platform.LINKEDIN],
    description: 'Platforms to style the posts for'
  })
  @IsArray()
  @IsEnum(Platform, { each: true })
  platforms: Platform[];

  @ApiPropertyOptional({ 
    description: 'Optional Brand Kit ID to enforce specific brand voice' 
  })
  @IsOptional()
  @IsString()
  brandKitId?: string;
}