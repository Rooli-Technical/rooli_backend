import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsNotEmpty } from "class-validator";

export class UpdateWorkspaceMemberRoleDto {
  @ApiPropertyOptional({
    description: 'Workspace role override. Set null to remove override (fallback to org role).',
    nullable: true,
    example: null,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId: string | null;
}