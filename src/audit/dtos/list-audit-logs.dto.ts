import { PaginationDto } from "@/common/dtos/pagination.dto";
import { AuditResourceType } from "@generated/enums";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum, IsString } from "class-validator";

export class ListAuditLogsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: AuditResourceType })
  @IsOptional()
  @IsEnum(AuditResourceType)
  resourceType?: AuditResourceType;

  @ApiPropertyOptional({ description: 'Filter by actor user email substring' })
  @IsOptional()
  @IsString()
  actorEmail?: string;
}