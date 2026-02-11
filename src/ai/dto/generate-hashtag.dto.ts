import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty } from "class-validator";

export class GenerateHashtagsDto {
  @ApiProperty({
    description: 'The post content or topic to generate hashtags for',
    example: 'Launching a new SaaS product for small businesses',
  })
  @IsString()
  @IsNotEmpty()
  prompt: string;
}