import { ApiProperty } from "@nestjs/swagger";
import { BulkValidationErrorDto } from "./bulk-validation-error.dto";
import { PreparedPostDto } from "../request/prepared-post.dto";

export class BulkValidateResponseDto {
  @ApiProperty({ type: [PreparedPostDto] })
  validPosts: PreparedPostDto[];

  @ApiProperty({ type: [BulkValidationErrorDto] })
  errors: BulkValidationErrorDto[];
}