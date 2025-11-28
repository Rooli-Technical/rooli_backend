import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayNotEmpty,
  IsBoolean,
} from 'class-validator';

export class UpdateRoleDto {
  @ApiPropertyOptional({
    description: 'New machine-readable name for the role.',
    example: 'manager',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description of the role.',
    example: 'Managers can oversee teams and approve requests.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Human-friendly display name for the updated role.',
    example: 'Manager',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Updated list of permission IDs assigned to this role.',
    type: [String],
    example: ['approve-requests', 'view-reports'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  permissionIds?: string[];

  @ApiPropertyOptional({
    description: 'Whether this role should be marked as the default role.',
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isDefault?: boolean;
}
