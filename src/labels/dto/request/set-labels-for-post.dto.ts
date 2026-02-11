import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsString } from "class-validator";

export class SetLabelsForPostDto {
  @ApiProperty({
    description: 'Replace post labels with exactly these label IDs',
    example: ['lbl_1', 'lbl_2'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  labelIds: string[];
}