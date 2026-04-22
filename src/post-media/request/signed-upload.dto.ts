import { IsString, IsInt, Min, Max, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignedUploadDto {
  @ApiProperty({
    description: 'The name of the file',
    example: 'image.jpg',
  })
  @IsString()
  @MaxLength(500)
  filename: string;

  @ApiProperty({
    description: 'The size of the file in bytes',
    example: 1024,
  })
  @IsInt()
  @Min(1)
  @Max(500 * 1024 * 1024) // 500MB hard cap
  size: number;

  @ApiProperty({
    description: 'The mime type of the file',
    example: 'image/jpeg',
  })
  @IsString()
  @Matches(/^(image|video)\//, {
    message: 'mimeType must start with image/ or video/',
  })
  mimeType: string;
}
