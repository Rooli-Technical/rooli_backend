import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { GetCalendarQueryDto } from './dtos/get-calendar.dto';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';



@ApiTags('Calendar')
@ApiBearerAuth()
@Controller('/api/v1/workspaces/:workspaceId/calendar')
@UseGuards(FeatureGuard)
@RequireFeature('visualCalendar') 
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get()
  @ApiOperation({ summary: 'Get calendar events (posts + campaigns + holidays/observances)' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiQuery({ name: 'from', required: true, example: '2026-02-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-03-01' })
  @ApiQuery({
    name: 'include',
    required: false,
    example: 'posts,campaigns,holidays',
    description: 'Comma-separated: posts,campaigns,holidays',
  })
  @ApiQuery({ name: 'country', required: false, example: 'NG' })
  @ApiQuery({ name: 'state', required: false, example: 'LA' })
  @ApiQuery({ name: 'lang', required: false, example: 'en' })
  @ApiQuery({ name: 'includeDrafts', required: false, example: 'false' })
  @ApiQuery({ name: 'platform', required: false, example: 'LINKEDIN' })
  getCalendar(
    @Param('workspaceId') workspaceId: string,
    @Query() query: GetCalendarQueryDto,
  ) {
    return this.calendarService.getCalendar(workspaceId, query);
  }
}

