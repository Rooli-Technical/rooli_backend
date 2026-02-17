import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';


export class AddWorkspaceMemberDto {
  @ApiProperty({ description: 'Workspace ID' })
  @IsString()
  @IsNotEmpty()
  workspaceId: string;

  @ApiProperty({ description: 'OrganizationMember ID' })
  @IsString()
  @IsNotEmpty()
  organizationMemberId: string;

  @ApiPropertyOptional({
    description: 'Optional workspace override role ID. If omitted/null -> no override.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string | null;
}

