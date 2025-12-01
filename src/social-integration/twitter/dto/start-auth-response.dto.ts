import { ApiProperty } from '@nestjs/swagger';

export class StartAuthResponseDto {
  @ApiProperty({
    description: 'Twitter authentication URL the frontend should redirect the user to',
    example:
      'https://api.twitter.com/oauth/authenticate?oauth_token=some_oauth_token',
  })
  url: string;

  @ApiProperty({
    description:
      'Temporary oauth token (frontend generally does not need to store this; backend uses it server-side).',
    example: 'some_oauth_token',
  })
  oauthToken: string;
}