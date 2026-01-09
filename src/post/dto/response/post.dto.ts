import { ApiProperty } from '@nestjs/swagger';

export class MediaFileDto {
  @ApiProperty({ example: 'file_123' })
  id: string;

  @ApiProperty({ example: 'https://example.com/image.png' })
  url: string;
}

export class PostMediaDto {
  @ApiProperty({ example: 'media_123' })
  mediaFileId: string;

  @ApiProperty({ type: MediaFileDto })
  mediaFile: MediaFileDto;

  @ApiProperty({ example: 0 })
  order: number;
}

export class PostDto {
  @ApiProperty({ example: 'post_123' })
  id: string;

  @ApiProperty({ example: 'Hello World!' })
  content: string;

  @ApiProperty({ example: 'DRAFT' })
  status: string;

  @ApiProperty({ example: '2026-01-08T10:00:00.000Z' })
  scheduledAt: Date;

  @ApiProperty({ type: [PostMediaDto], example: [{ mediaFileId: 'media_123', mediaFile: { id: 'file_123', url: 'https://example.com/image.png' }, order: 0 }] })
  media: PostMediaDto[];

  @ApiProperty({ type: () => PostDto, nullable: true, example: null })
  parentPost?: PostDto;

  @ApiProperty({ type: [PostDto], example: [] })
  childPosts: PostDto[];
}
