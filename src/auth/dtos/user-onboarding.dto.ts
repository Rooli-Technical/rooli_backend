import { BillingInterval, UserType } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsEmail,
  IsOptional,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description: 'The ID of the plan to upgrade to',
    example: 'plan_123',
  })
  @IsString()
  @IsOptional()
  upfrontPlanId?: string;

  @ApiPropertyOptional({
    description: 'The billing interval for the plan',
    example: 'MONTHLY',
    enum: ['MONTHLY', 'ANNUAL'],
  })
  @IsEnum(BillingInterval)
  @IsOptional()
  billingInterval?: 'MONTHLY' | 'ANNUAL';

  @ApiPropertyOptional({
    description: 'The type of users in the organization',
    example: 'INDIVIDUAL',
    enum: UserType,
  })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiPropertyOptional({
    description: 'New workSpace for agencies',
    example: 'Coca Cola',
  })
  @IsString()
  @IsOptional()
  initialWorkspaceName?: string;
}
