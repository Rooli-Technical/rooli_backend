import { PaginationDto } from '@/common/dtos/pagination.dto';
import { PostStatus, ContentType } from '@generated/enums';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class GetWorkspacePostsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PostStatus, description: 'Filter by post status' })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  @ApiPropertyOptional({ enum: ContentType, description: 'Filter by content type' })
  @IsOptional()
  @IsEnum(ContentType)
  contentType?: ContentType;

  @ApiPropertyOptional({ description: 'Search in post content' })
  @IsOptional()
  @IsString()
  search?: string;
}
