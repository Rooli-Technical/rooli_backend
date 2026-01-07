import { ApiProperty } from "@nestjs/swagger";
import { SocialProfileDto } from "./social-profile.dto";

export class BulkAddProfilesResponseDto {
  @ApiProperty({ example: 'Processed 1 profiles.' })
  message: string;

  @ApiProperty({ type: [SocialProfileDto] })
  added: SocialProfileDto[];

  @ApiProperty({ type: [String], example: [] })
  failures: string[];
}
