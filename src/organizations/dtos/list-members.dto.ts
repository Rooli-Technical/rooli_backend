import { PaginationDto } from "@/common/dtos/pagination.dto";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class ListMembersQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search by member name/email (implementation-defined)',
    example: 'john',
  })
  @IsOptional()
  @IsString()
  search?: string;
}