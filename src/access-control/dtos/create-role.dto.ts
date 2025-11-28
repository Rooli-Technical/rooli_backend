import { RoleScope } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({
    description:
      'Machine-readable name of the role (e.g., "admin", "teacher").',
    example: 'admin',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description explaining the purpose of the role.',
    example: 'Administrators have full access to system features.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Human-friendly display name for the role.',
    example: 'Administrator',
  })
  @IsString()
  @IsNotEmpty()
  displayName: string;

  @ApiProperty({
    description:
      'Scope at which this role applies (e.g., system-level or organization-level).',
    enum: RoleScope,
    example: RoleScope.ORGANIZATION,
  })
  @IsEnum(RoleScope)
  scope: RoleScope;

  @ApiPropertyOptional({
    description:
      'ID of the organization this role belongs to. Required for organization-scoped roles.',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'List of permission IDs that will be assigned to this role.',
    type: [String],
    example: ['read-users', 'manage-users', 'delete-users'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  permissionIds?: string[];

  @ApiPropertyOptional({
    description:
      'If true, this role will be automatically assigned to new users.',
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isDefault?: boolean;
}
