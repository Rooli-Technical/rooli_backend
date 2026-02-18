import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsString } from "class-validator";

export class ReplaceRolePermissionsDto {
  @ApiProperty({ type: [String], description: 'Full replacement using CUIDs' })
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}