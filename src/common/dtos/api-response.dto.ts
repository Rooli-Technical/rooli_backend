import { ApiProperty } from '@nestjs/swagger';

export class ApiResponseDto<T> {
  @ApiProperty({ example: 200 })
  statusCode: number;

  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Operation successful', required: false })
  message?: string;

@ApiProperty({ nullable: true }) 
  data: any;

  @ApiProperty({ example: '2026-01-07T12:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/v1/users' })
  path: string;
}