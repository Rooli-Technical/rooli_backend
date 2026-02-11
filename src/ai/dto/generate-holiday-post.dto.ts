import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class GenerateHolidayPostDto {
  @ApiProperty({
    description: 'The name of the holiday',
    example: 'Independence Day',
  })
  @IsString()
  @IsNotEmpty()
  holidayName: string;

  @ApiProperty({
    description: 'The targeted social media platform',
    enum: ['TWITTER', 'LINKEDIN', 'INSTAGRAM', 'FACEBOOK'],
  })
  @IsEnum(['TWITTER', 'LINKEDIN', 'INSTAGRAM', 'FACEBOOK'])
  platform: 'TWITTER' | 'LINKEDIN' | 'INSTAGRAM' | 'FACEBOOK';

  @ApiPropertyOptional({ description: 'ID of the Brand Kit to apply' })
  @IsString()
  @IsOptional()
  brandKitId?: string;

  @ApiPropertyOptional({ 
    description: 'Character limit for the platform',
    example: 280 
  })
  @IsNumber()
  @IsOptional()
  maxChars?: number;
}