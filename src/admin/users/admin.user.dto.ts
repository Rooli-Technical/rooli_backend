import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, Max, Min } from "class-validator";

export class AdminUserListItemDto {


  @ApiProperty({ example: 'crtx', nullable: true })
  id: string | null;

  @ApiProperty({ example: 'Chidi', nullable: true })
  firstName: string | null;

  @ApiProperty({ example: 'Okafor', nullable: true })
  lastName: string | null;

  @ApiProperty({ example: 'INDIVIDUAL', enum: ['INDIVIDUAL', 'AGENCY'] })
  userType: string;

  @ApiProperty({ example: '2026-03-23T12:05:30.434Z', nullable: true })
  lastActiveAt: string | null;

  @ApiProperty({ example: '2026-01-15T08:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: true })
  isEmailVerified: boolean;

  @ApiProperty({ example: null, nullable: true, description: 'Non-null = suspended' })
  lockedUntil: string | null;

  @ApiProperty({ example: null, nullable: true, description: 'Non-null = banned' })
  deletedAt: string | null;

  @ApiProperty({ example: 4, description: 'Total workspaces across all orgs this user belongs to' })
  workspaceCount: number;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 120 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 6 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;
}

export class AdminUserListResponseDto {
  @ApiProperty({ type: [AdminUserListItemDto] })
  data: AdminUserListItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}

export class SuspendResponseDto {
  @ApiProperty({ example: '2099-12-31T23:59:59.999Z' })
  lockedUntil: string;
}

export class ReactivateResponseDto {
  @ApiProperty({ example: null, nullable: true })
  lockedUntil: string | null;

  @ApiProperty({ example: null, nullable: true })
  deletedAt: string | null;
}

export class SuspendUserDto {
  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59.999Z',
    description: 'Optional — omit for indefinite suspension (defaults to 2099).',
  })
  @IsOptional()
  @IsDateString()
  suspendUntil?: string;
}
export class PaginationDto {
  @ApiPropertyOptional({ example: 1, description: 'Page number. Defaults to 1.', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;
 
  @ApiPropertyOptional({ example: 20, description: 'Items per page. Defaults to 20. Max 100.', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
