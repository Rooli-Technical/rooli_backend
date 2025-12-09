// dto/filter-roles.dto.ts
import { PaginationDto } from '@/common/dtos/pagination.dto';
import { RoleScope } from '@generated/enums';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class FilterRolesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: RoleScope })
  @IsOptional()
  @IsEnum(RoleScope)
  scope?: RoleScope;

  @ApiPropertyOptional({ description: 'Organization ID (for org roles)' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Search by name or display name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Include system roles', default: true })
  @IsOptional()
  includeSystem?: boolean;
}
