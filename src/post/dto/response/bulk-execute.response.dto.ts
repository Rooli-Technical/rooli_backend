import { ApiProperty } from "@nestjs/swagger";

export class BulkExecuteResponseDto {
  @ApiProperty({ example: 'SUCCESS' })
  status: string;

  @ApiProperty({ example: 25 })
  count: number;
}
