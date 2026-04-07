import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PostApprovalDto {
  @ApiProperty({
    example: 'pa_9f3c2b1a',
    description: 'Unique identifier for the post approval request',
  })
  id: string;

  @ApiProperty({
    example: 'post_83kd92ls',
    description: 'ID of the post awaiting approval',
  })
  postId: string;

  @ApiProperty({
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    example: 'PENDING',
    description: 'Current approval status',
  })
  status: string;

  @ApiPropertyOptional({
    example: 'Please fix the caption grammar',
    description: 'Optional notes from the reviewer',
  })
  notes?: string;

  @ApiProperty({
    example: 'user_72jd82ks',
    description: 'User who requested the approval',
  })
  requestedBy: string;

  @ApiPropertyOptional({
    example: 'user_admin_1',
    description: 'Admin or reviewer who reviewed the post',
  })
  reviewedBy?: string;

  @ApiProperty({
    example: '2026-01-12T10:42:18.123Z',
    description: 'When the approval request was created',
  })
  createdAt: string;

  @ApiPropertyOptional({
    example: '2026-01-12T11:05:44.981Z',
    description: 'When the post was reviewed',
  })
  reviewedAt?: string;
}
