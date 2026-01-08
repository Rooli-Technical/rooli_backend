import { ApiProperty } from "@nestjs/swagger";

export class BulkValidationErrorDto {
  @ApiProperty({ example: 2 })
  row: number;

  @ApiProperty({ example: 'Invalid scheduled_at' })
  message: string;
}