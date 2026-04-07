import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReviewApprovalDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  status: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ example: 'Please fix the caption grammar' })
  notes?: string;
}
