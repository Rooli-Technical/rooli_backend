
import { IsEmail, IsNotEmpty, IsOptional, IsString} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateInviteDto {
  @ApiProperty({ example: 'colleague@company.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'The Role CUID' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ description: 'The Workspace CUID. If null, invites to Org wide.' })
  @IsOptional()
  @IsString()
  workspaceId?: string;
}