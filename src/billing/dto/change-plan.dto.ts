import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum BillingIntervalEnum {
  MONTHLY = 'MONTHLY',
  ANNUAL = 'ANNUAL',
}

export class ChangePlanDto {
  @ApiProperty({
    example: 'clxyz123abc',
    description: 'The ID of the plan the user wants to switch to.',
  })
  @IsString()
  @IsNotEmpty()
  newPlanId: string;

  @ApiProperty({
    enum: BillingIntervalEnum,
    example: BillingIntervalEnum.MONTHLY,
    description: 'The billing cycle for the new plan.',
  })
  @IsEnum(BillingIntervalEnum)
  interval: BillingIntervalEnum;
}