import { PartialType } from '@nestjs/mapped-types';
import { CreateOrganizationDto } from './create-organization.dto';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  settings?: Record<string, any>;
}