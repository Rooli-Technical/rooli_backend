import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePaymentDto {
  @ApiProperty({
    description: 'CUID of the selected subscription plan',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsNotEmpty()
  @IsString()
  planId: string;

  @ApiProperty({
    description: 'The interval of the subscription',
    enum: ['MONTHLY', 'ANNUAL'],
    example: 'MONTHLY',
  })
  @IsNotEmpty()
  @IsString()
  interval: 'MONTHLY' | 'ANNUAL';
}
