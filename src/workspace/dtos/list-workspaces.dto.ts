import { PaginationDto } from "@/common/dtos/pagination.dto";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsIn } from "class-validator";

export class ListWorkspacesQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search term (matches workspace name/slug, etc.)',
    example: 'marketing',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Field to order by',
    enum: ['createdAt', 'updatedAt', 'name'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'name'])
  orderBy?: 'createdAt' | 'updatedAt' | 'name' = 'createdAt';

  @ApiPropertyOptional({
    description: 'Order direction',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  orderDir?: 'asc' | 'desc' = 'desc';
}