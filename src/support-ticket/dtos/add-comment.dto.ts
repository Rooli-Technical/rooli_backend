import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsBoolean, IsOptional, IsArray } from "class-validator";

export class AddCommentDto {
  @ApiProperty({ example: 'We are looking into this right now.' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({ description: 'True if the comment is from a support agent' })
  @IsBoolean()
  isFromSupport: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaFileIds?: string[];
}