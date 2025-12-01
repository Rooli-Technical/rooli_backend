import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class CallbackQueryDto {
  @ApiProperty({
    name: 'oauth_token',
    description: 'OAuth token (returned by Twitter in callback)',
    example: 'some_oauth_token',
  })
  @IsNotEmpty()
  @IsString()
  oauth_token: string;

  @ApiProperty({
    name: 'oauth_verifier',
    description: 'OAuth verifier code (returned by Twitter in callback)',
    example: 'some_oauth_verifier',
  })
  @IsNotEmpty()
  @IsString()
  oauth_verifier: string;
}