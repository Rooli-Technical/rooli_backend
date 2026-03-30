import { PaginationDto } from '@/common/dtos/pagination.dto';
import { PlanTier, PlanStatus } from '@generated/enums';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsBoolean, IsEnum } from 'class-validator';

export class GetAllOrganizationsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by organization name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: PlanTier, description: 'Filter by plan tier' })
  @IsOptional()
  @IsEnum(PlanTier)
  planTier?: PlanTier;

  @ApiPropertyOptional({
    enum: PlanStatus,
    description: 'Filter by plan status',
  })
  @IsOptional()
  @IsEnum(PlanStatus)
  planStatus?: PlanStatus;
}
