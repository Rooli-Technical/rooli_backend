import { ApiProperty } from '@nestjs/swagger';
import { PreparedPostDto } from './prepared-post.dto';

export class ExecuteBulkScheduleDto {
  @ApiProperty({
    type: [PreparedPostDto],
    description: 'List of validated posts to be scheduled',
  })
  posts: PreparedPostDto[];
}
