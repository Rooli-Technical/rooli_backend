import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreatePostDto } from './create-post.dto';

export class BulkCreatePostDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50, { message: 'You can only bulk schedule up to 50 posts at a time.' })
  @ValidateNested({ each: true })
  @Type(() => CreatePostDto)
  posts: CreatePostDto[];
}
