import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString} from 'class-validator';

export class UpdateOrgMemberRoleDto {
  @ApiProperty({
    description: 'The UUID of the new Organization Role to assign to the member',
    example: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  })
  @IsNotEmpty()
@IsString()
  roleId: string;
}