import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type CalendarEventType = 'POST' | 'HOLIDAY' | 'OBSERVANCE' | 'CAMPAIGN';

export class CalendarEventDto {
  @ApiProperty({ example: 'post_clx123' })
  id: string;

  @ApiProperty({ enum: ['POST', 'HOLIDAY', 'OBSERVANCE', 'CAMPAIGN'] })
  type: CalendarEventType;

  @ApiProperty({ example: 'LinkedIn Post: Launch update' })
  title: string;

  @ApiProperty({
    description: 'ISO string. For all-day events you can use YYYY-MM-DD.',
    example: '2026-02-10T08:00:00.000Z',
  })
  start: string;

  @ApiPropertyOptional({
    description: 'ISO string (optional). Campaigns often have an end date.',
    example: '2026-02-12T08:00:00.000Z',
  })
  end?: string;

  @ApiPropertyOptional({ example: true })
  allDay?: boolean;

  @ApiPropertyOptional({
    description: 'Hex color hint for UI',
    example: '#1877F2',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'Extra metadata for click handlers (postId, status, etc.)',
    example: { postId: 'post_1', status: 'SCHEDULED' },
  })
  meta?: Record<string, any>;

}
