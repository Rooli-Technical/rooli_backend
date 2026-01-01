import { UserType } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsEnum } from 'class-validator';

export class OnboardingDto {
  @ApiProperty({
    description: 'The name of the organization',
    example: 'Acme Corporation',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

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

  @ApiProperty({
    description: 'The plan ID to subscribe the organization to upon creation',
    example: 'plan_1234567890',
  })
  @IsNotEmpty()
  @IsString()
  planId: string;

  @ApiPropertyOptional({
    description: 'The type of users in the organization',
    example: 'INDIVIDUAL',
    enum: UserType,
  })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiPropertyOptional({
    description: 'Custom slug for the organization',
    example: 'acme-corp',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    description: 'The country for billing',
    example: 'NG',
  })
  @IsString()
  @IsOptional()
  billingCountry?: string;

  @ApiPropertyOptional({
    description: 'New workSpace for agencies',
    example: 'Coca Cola',
  })
  @IsString()
  @IsOptional()
  initialWorkspaceName?: string;
}
