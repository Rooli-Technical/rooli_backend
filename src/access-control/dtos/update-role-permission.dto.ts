import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayNotEmpty } from 'class-validator';

export class UpdateRolePermissionsDto {
  @ApiProperty({
    example: ['permId1', 'permId2'],
    description: 'List of permission IDs',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissionIds: string[];
}