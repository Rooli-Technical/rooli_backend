import { UserType } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsBoolean, IsNotEmpty, IsEnum } from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({
    description: 'The name of the organization',
    example: 'Acme Corporation',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    description: 'A URL-friendly unique identifier for the organization',
    example: 'acme-corp',
  })
  @IsNotEmpty()
  @IsString()
  slug: string;

  @ApiPropertyOptional({
    description: 'The timezone of the organization',
    example: 'Africa/Lagos',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'The billing email for the organization',
    example: 'billing@acme.com',
  })
  @IsNotEmpty()
  @IsString()
  email: string;

  @IsNotEmpty() 
  @IsString() 
  planId: string;

  @IsOptional() 
  @IsEnum(UserType)
  userType?: UserType;
}