import { PaginationDto } from '@/common/dtos/pagination.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GetOrganizationMediaDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by type (e.g. "image" or "video")',
    example: 'image',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Search media by original file name (case-insensitive)',
    example: 'banner',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
