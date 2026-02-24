import { PaginationDto } from "@/common/dtos/pagination.dto";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class ListConversationsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by snippet or username' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by status (e.g., OPEN, CLOSED)' })
   @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned agent ID. Use "unassigned" for null.' })
   @IsOptional()
  @IsString()
  assignedMemberId?: string;

  @ApiPropertyOptional({ description: 'Filter by archived status', type: Boolean })
   @IsOptional()
  @IsString()
  isArchived?: boolean;
}