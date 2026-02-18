import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export enum PermissionScope {
  ORGANIZATION = 'ORGANIZATION',
  WORKSPACE = 'WORKSPACE',
  SYSTEM = 'SYSTEM',
}


export const PermissionNameFormats = ['SCOPE_RESOURCE_ACTION', 'RESOURCE_ACTION'] as const;
export type PermissionNameFormat = typeof PermissionNameFormats[number];

export class ListPermissionsQuery {
  @ApiPropertyOptional({ 
    enum: PermissionScope, 
    description: 'Filter permissions by their applicable scope' 
  })
  @IsOptional()
  @IsEnum(PermissionScope)
  scope?: PermissionScope;
}