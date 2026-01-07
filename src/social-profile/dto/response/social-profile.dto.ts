import { Platform } from "@generated/enums";
import { ApiProperty } from "@nestjs/swagger";

export class SocialProfileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  workspaceId: string;

  @ApiProperty()
  socialConnectionId: string;

  @ApiProperty()
  platform: Platform;

  @ApiProperty()
  platformId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  username: string;

  @ApiProperty()
  picture: string;

  @ApiProperty()
  followerCount: number;

  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
