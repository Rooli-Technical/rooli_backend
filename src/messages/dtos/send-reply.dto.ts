import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";


export class SendReplyDto {
  @ApiProperty({ description: 'The text content of the reply' })
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({ description: 'Workspace Member ID of the member sending the reply' })
  @IsNotEmpty()
  @IsString()
  memberId: string

  @ApiPropertyOptional({
    description: 'Array of attachments to send',
    example: [{ type: 'IMAGE', url: 'https://example.com/image.png' }],
  })
  @IsOptional()
  attachments?: Array<{
    type: string;
    url: string;
    proxyUrl?: string;
    thumbnailUrl?: string;
    mimeType?: string;
    fileSizeBytes?: number;
    meta?: any;
  }>;
}
