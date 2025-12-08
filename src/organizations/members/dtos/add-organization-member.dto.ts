import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional } from "class-validator";

export class AddOrganizationMemberDto {
  @ApiProperty({ example: 'user_cuid_here' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'role_cuid_here' })
  @IsString()
  @IsNotEmpty()
  roleId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  permissions?: Record<string, any>;
}