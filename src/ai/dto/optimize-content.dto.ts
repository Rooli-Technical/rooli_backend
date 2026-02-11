import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty } from "class-validator";

export class OptimizeContentDto {
  @ApiProperty({
    description: 'The original text you want to improve',
    example: 'This is our new app it is good for teams.',
  })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: 'The instruction for the AI editor',
    example: 'Make it sound professional and fix grammar.',
  })
  @IsString()
  @IsNotEmpty()
  instruction: string;
}