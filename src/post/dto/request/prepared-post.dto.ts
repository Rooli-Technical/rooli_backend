import { ApiProperty } from "@nestjs/swagger";

export class PreparedPostDto {
  @ApiProperty({ example: 'Hello world' })
  content: string;

  @ApiProperty({ example: '2026-01-08T10:00:00.000Z' })
  scheduledAt: string;

  @ApiProperty({ type: [String], example: ['sp_123', 'sp_456'] })
  profileIds: string[];

  @ApiProperty({ example: 'https://image.url/img.png', required: false })
  mediaUrl?: string;
}