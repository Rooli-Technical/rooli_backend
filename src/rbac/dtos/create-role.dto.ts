import { RoleScope } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  MinLength,
  IsNotEmpty,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ enum: RoleScope, example: RoleScope.ORGANIZATION })
  @IsEnum(RoleScope)
  scope: RoleScope;

  @ApiProperty({ example: 'Project Manager' })
  @IsString()
  @MinLength(3)
  name: string;

  @ApiProperty({
    example: 'project-manager',
    description: 'URL-friendly identifier',
  })
  @IsString()
  @IsNotEmpty()
  slug: string;

  @ApiPropertyOptional({
    example: 'Responsible for managing workspace projects',
  })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Array of CUIDs' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionIds?: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isDefault?: boolean;
}

