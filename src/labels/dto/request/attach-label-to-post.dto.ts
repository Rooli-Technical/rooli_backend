import { ApiProperty } from "@nestjs/swagger";
import { IsArray, ArrayMinSize, IsString } from "class-validator";

export class AttachLabelsToPostDto {
  @ApiProperty({
    description: 'Label IDs to attach to a post',
    example: ['lbl_1', 'lbl_2'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  labelIds: string[];
}