import { IsNotEmpty, IsOptional, IsString, IsArray, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Platform } from '@generated/enums';

export class CreateSocialAccountDto {
  @ApiProperty({ description: 'ID of the organization', example: 'org_123abc' })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({ description: 'Social platform', enum: Platform })
  @IsString()
  platform: Platform;

  @ApiProperty({ description: 'Platform account ID', example: '1234567890' })
  @IsString()
  platformAccountId: string;

  @ApiProperty({ description: 'Username on the platform', example: 'john_doe' })
  @IsString()
  username: string;

  @ApiPropertyOptional({ description: 'Full name on the platform', example: 'John Doe' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Profile picture URL' })
  @IsOptional()
  @IsString()
  profilePicture?: string;

  @ApiPropertyOptional({ description: 'OAuth access token' })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @ApiPropertyOptional({ description: 'OAuth refresh token' })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @ApiPropertyOptional({ description: 'Token expiration date in UTC format', example: '2025-12-31T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  tokenExpiresAt?: Date;

  @ApiPropertyOptional({ description: 'Scopes granted by the token', example: ['email','profile'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}