import { Platform } from '@generated/enums';
import { IsEnum, IsOptional, IsDateString, IsUUID } from 'class-validator';

export class GetDashboardDto {
  @IsOptional()
  @IsUUID()
  socialAccountId?: string; // If null, return aggregate for ALL accounts

  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform; 

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;  
}