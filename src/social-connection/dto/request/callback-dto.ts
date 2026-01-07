import { Platform } from '@generated/enums';
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SocialCallbackDto {
  @ApiProperty({
    description: 'Required for Facebook/LinkedIn',
    required: false,
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({
    description: 'Required for Facebook/LinkedIn',
    required: false,
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ description: 'Required for Twitter', required: false })
  @IsOptional()
  @IsString()
  oauth_token?: string;

  @ApiProperty({ description: 'Required for Twitter', required: false })
  @IsOptional()
  @IsString()
  oauth_verifier?: string;
}
