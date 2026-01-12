
import { ApiProperty } from '@nestjs/swagger';
import { PaginationDto } from './pagination.dto';


export class PaginatedResponseDto<T> {
  @ApiProperty({ isArray: true })
  data: T[];

  @ApiProperty({ type: PaginationDto })
  meta: PaginationDto;
}