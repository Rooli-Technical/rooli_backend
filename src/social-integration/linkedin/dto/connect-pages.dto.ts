import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsArray } from "class-validator";

export class ConnectPagesBodyDto {
  @ApiProperty({ description: 'ID of the social account', example: 'sa_123abc' })
  @IsString()
  socialAccountId: string;

  @ApiProperty({ description: 'Array of LinkedIn page IDs to connect', example: ['page_1', 'page_2'] })
  @IsArray()
  @IsString({ each: true })
  pageUrns: string[];
}
