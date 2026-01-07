import { ApiProperty } from '@nestjs/swagger';

export class AuthUrlResponseDto {
  @ApiProperty({ 
    example: 'https://www.instagram.com/oauth/authorize?...', 
    description: 'The URL to redirect the user to' 
  })
  url: string;
}