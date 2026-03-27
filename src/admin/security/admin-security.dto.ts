// dto/admin-session.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

class AdminSessionUserDto {
  @ApiProperty({ example: 'John' })
  @Expose()
  firstName: string;

  @ApiProperty({ example: 'doe' })
  @Expose()
  lastName: string;

  @ApiProperty({ example: 'SUPER_ADMIN' })
  @Expose()
  userType: string;
}

export class AdminSessionDto {
  @ApiProperty({ example: 'c1f2d3e4-5678-90ab-cdef-1234567890ab' })
  @Expose()
  id: string;

  @ApiProperty({ example: '192.168.1.1' })
  @Expose()
  ip: string;


  @ApiProperty({ example: true })
  @Expose()
  isActive: boolean;

  @ApiProperty({ example: '2026-03-25T12:00:00Z' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ type: AdminSessionUserDto })
  @Expose()
  @Type(() => AdminSessionUserDto)
  admin: AdminSessionUserDto;
}

export class IpWhitelistDto {
  @ApiProperty({ example: 'b1a2c3d4-5678-90ab-cdef-1234567890ab' })
  @Expose()
  id: string;

  @ApiProperty({ example: '192.168.0.0/24' })
  @Expose()
  ipRange: string;

  @ApiProperty({ example: '2026-03-25T12:00:00Z' })
  @Expose()
  createdAt: Date;
}

export class AdminSecurityOverviewDto {
  @ApiProperty({ type: [AdminSessionDto] })
  @Type(() => AdminSessionDto)
  sessions: AdminSessionDto[];

  @ApiProperty({ type: [IpWhitelistDto] })
  @Type(() => IpWhitelistDto)
  whitelist: IpWhitelistDto[];
}

export class AddIpDto {
  @ApiProperty({
    example: '192.168.0.0/24',
    description: 'IP or CIDR range',
  })
  @IsString()
  @Matches(/^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]+)?$/, {
    message: 'Invalid IP or CIDR format',
  })
  ipRange: string;
}

export class MessageDto {
  @ApiProperty({ example: 'Operation successful' })
  message: string;
}

export class RevokeSessionDto {
  @ApiProperty({ example: 'c1f2d3e4-5678-90ab-cdef-1234567890ab' })
  @IsString()
  sessionId: string;
}
