
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InviteMemberDto {
  @ApiProperty({
    example: 'jane.doe@example.com',
    description: 'Email address of the user to invite',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'role_id_12345',
    description: 'RoleId to assign to the invited member',
  })
  @IsNotEmpty()
  roleId: string;

  @ApiPropertyOptional({
    example: 'Welcome to our team! Excited to collaborate with you.',
    description: 'Optional custom message included in the invitation email',
  })
  @IsOptional()
  @IsString()
  message?: string;
}