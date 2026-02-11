import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class GenerateImageDto {
  @ApiProperty({
    description: 'The visual description of the image you want to generate',
    example: 'A futuristic office with a view of Mars',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  prompt: string;

  @ApiPropertyOptional({
    description: 'The artistic style (e.g., photorealistic, 3D render, minimalist)',
    example: 'photorealistic digital art',
  })
  @IsString()
  @IsOptional()
  style?: string;
}