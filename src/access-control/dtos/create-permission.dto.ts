import { PermissionScope, PermissionResource, PermissionAction } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsEnum,
} from 'class-validator';


export class CreatePermissionDto {
  @ApiProperty({
    description: 'Unique name of the permission (machine-readable).',
    example: 'manage_users',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description of what this permission allows.',
    example: 'Allows managing user accounts within the organization.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Permission scope level — determines where this permission applies.',
    enum: PermissionScope,
    example: PermissionScope.ORGANIZATION,
  })
  @IsEnum(PermissionScope)
  scope: PermissionScope;

  @ApiProperty({
    description: 'The resource (entity/type) the permission applies to.',
    enum: PermissionResource,
    example: PermissionResource.POSTS,
  })
  @IsEnum(PermissionResource)
  resource: PermissionResource;

  @ApiProperty({
    description: 'The action allowed on the resource for this permission.',
    enum: PermissionAction,
    example: PermissionAction.CREATE,
  })
  @IsEnum(PermissionAction)
  action: PermissionAction;
}
