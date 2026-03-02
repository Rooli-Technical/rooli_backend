import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendCommentReplyDto {
  @ApiProperty({ example: 'Thanks for reaching out! We will DM you.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2200) // Instagram's character limit for comments
  content: string;
}