import { ApiProperty } from '@nestjs/swagger';


export class SocialPageDto {
  @ApiProperty({ example: '123456789' })
  id: string;

  @ApiProperty({ example: 'My Business Page' })
  name: string;

  @ApiProperty({ example: 'FACEBOOK' })
  platform: string;

  @ApiProperty({ example: 'PAGE' })
  type: string;
}

export class SocialConnectionResponseDto {
  @ApiProperty({ example: 'Connection successful' })
  message: string;

  @ApiProperty({ example: 'conn_123456' })
  connectionId: string;

  @ApiProperty({ type: [SocialPageDto] })
  availablePages: SocialPageDto[];
}