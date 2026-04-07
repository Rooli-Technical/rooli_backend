import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { PaginationDto } from '@/common/dtos/pagination.dto';

export class NotificationListDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'The ID of the last notification received (for cursor-based pagination) Optional',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Filter to only show unread notifications Optional',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  onlyUnread?: boolean = false;
}
