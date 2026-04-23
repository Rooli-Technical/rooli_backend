import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsScheduler } from './scheduler/analytics.scheduler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiQuery,
  ApiOkResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { subDays } from 'date-fns/subDays';
import { startOfDay, endOfDay } from 'date-fns';
import { BypassSubscription } from '@/common/decorators/bypass-subscription.decorator';

@Controller('analytics')
@ApiBearerAuth()
@ApiTags('Analytics (Admin / Debug)')
export class AnalyticsController {
  constructor(
    private readonly scheduler: AnalyticsScheduler,
    private readonly service: AnalyticsService,
  ) {}

  @Post('trigger-test')
  @Public()
  @ApiOperation({
    summary: 'Manually trigger daily analytics scheduling',
    description: `
⚠️ **Admin / Debug only**

This endpoint manually triggers the daily analytics scheduler.
It scans all active social profiles and enqueues analytics fetch jobs
into the BullMQ \`analytics-queue\`.
`,
  })
  @ApiResponse({
    status: 200,
    description: 'Analytics jobs were successfully scheduled',
    schema: {
      example: {
        message: 'Jobs scheduled successfully!',
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Scheduler failed while enqueueing analytics jobs',
  })
  async triggerTest() {
    console.log('👇 Manually triggering analytics job...');

    await this.scheduler.scheduleDailyFetch();

    return { message: 'Jobs scheduled successfully!' };
  }

  @Post('test')
  @Public()
  @ApiOperation({
    summary: 'Manually fetch analytics for a single profile or post',
    description: `
⚠️ **Admin / Debug only**
This endpoint manually triggers analytics fetching logic for testing purposes.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          example: 'cmkxyz123socialprofile',
          description: 'Internal SocialProfile ID',
        },
        postDestinationId: {
          type: 'string',
          example: 'cmkabc456post',
          description:
            'Optional internal Post Destination ID to fetch analytics for',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Analytics fetch executed successfully',
    schema: {
      example: {
        message: 'Analytics fetch completed',
      },
    },
  })
  @Post('test')
  async testFetch(
    @Body() body: { profileId: string; postDestinationId?: string },
  ) {
    await this.service.testFetch(body);
  }

  @Get('calendar/:workspaceId')
  @ApiOperation({
    summary: 'Get high-level dashboard metrics for the calendar',
    description:
      'Returns counts for scheduled posts this week, drafts, published posts this month, and connected accounts.',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'The UUID of the workspace to fetch metrics for',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({ status: 404, description: 'Workspace not found.' })
  async getCalendarMetrics(@Param('workspaceId') workspaceId: string) {
    return await this.service.getCalendarMetrics(workspaceId);
  }

  @Get('account/:profileId')
  @ApiOperation({
    summary: 'Get account performance history (followers, views, etc.)',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Lookback window (default 30)',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (YYYY-MM-DD)',
  })
  async getAccountStats(
    @Param('profileId') profileId: string,
    @Query('days') days?: number,
  ) {
    const lookback = days ? Number(days) : 30;
    const end = new Date();
    const start = subDays(end, lookback);

    return this.service.getAccountHistory(profileId, start, end);
  }

  @Get('post/:postDestinationId')
  @ApiOperation({ summary: 'Get performance history for a specific post' })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Lookback window (default 30)',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (YYYY-MM-DD)',
  })
  async getPostStats(
    @Param('postDestinationId') postDestinationId: string,
    @Query('days') days?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    let start, end;
    if (startDate && endDate) {
      start = startOfDay(new Date(startDate));
      end = endOfDay(new Date(endDate));
    } else {
      const lookback = days ? Number(days) : 30;
      end = new Date();
      start = subDays(end, lookback);
    }
    return this.service.getPostHistory(postDestinationId, start, end);
  }

  @Get('/workspaces/:id/dashboard')
  @BypassSubscription()
  @ApiOperation({
    summary: 'Get workspace analytics dashboard (plan-gated)',
    description:
      'Returns analytics dashboard aggregated across all active social profiles in a workspace. Response shape varies by plan tier.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    example: 'cmkdz...workspace_id',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Number of days to include (clamped to max 365). Default 30.',
    example: 30,
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (YYYY-MM-DD)',
    example: '2022-01-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (YYYY-MM-DD)',
    example: '2022-01-01',
  })
  async getWorkspaceDashboard(
    @Param('id') workspaceId: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Req() req?: any,
  ) {
    if (days < 1) throw new BadRequestException('days must be >= 1');
    return this.service.getWorkspaceDashboard(
      workspaceId,
      req?.user?.userPlan,
      days,
      startDate,
      endDate,
    );
  }

  @Get('profile/:profileId/dashboard')
  @ApiOperation({
    summary: 'Get detailed dashboard data for a specific social profile',
    description:
      'Returns historical account growth, demographics, and top performing posts.',
  })
  @ApiParam({
    name: 'profileId',
    description: 'The UUID of the social profile',
  })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 30 })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Explicit start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'Explicit end date (YYYY-MM-DD)',
  })
  @ApiResponse({
    status: 200,
    description: 'Unified analytics payload returned successfully.',
  })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async getProfileDashboard(
    @Param('profileId') profileId: string,
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // Note: Query params come in as strings, so we parse to number
    const daysCount = days ? parseInt(days, 10) : 30;
    return this.service.getProfileDashboard(
      profileId,
      daysCount,
      startDate,
      endDate,
    );
  }

  @Get(':workspaceId/dashboard')
  @ApiOperation({
    summary: 'Get app dashboard metrics',
  })
  @ApiResponse({
    status: 200,
    description: 'Get App home dashboard',
  })
  async getAppDashboard(@Param('workspaceId') workspaceId: string) {
    return this.service.getAppHomeDashboard(workspaceId);
  }

  @Get('profile/:profileId/best-time')
  @ApiOperation({
    summary: 'Get heatmap data for the best time to post',
    description:
      'Calculates average engagement across a 168-hour weekly matrix based on historical post performance.',
  })
  @ApiParam({ name: 'profileId', description: 'CUID of the social profile' })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Lookback window in days',
    example: 90,
  })
  @ApiResponse({
    status: 200,
    description: '168-hour heatmap matrix returned successfully.',
  })
  async getBestTime(
    @Param('profileId') profileId: string,
    @Query('days') days?: string,
  ) {
    const daysCount = days ? parseInt(days, 10) : 90;

    // Safety check: ensure the profile exists before running heavy aggregation
    return this.service.getWorkspaceBestTimeToPost(profileId, daysCount);
  }

  @Post('sync-destination/:destinationId')
  @ApiOperation({ 
    summary: 'Sync TikTok Video ID', 
    description: 'Polls TikTok to exchange a temporary publish_id for a permanent video_id.' 
  })
  @ApiParam({ 
    name: 'destinationId', 
    description: 'The ID of the PostDestination record',
    example: 'cmmdg1ji80003xuiaqd21fh8a' 
  })
  @ApiResponse({ status: 200, description: 'Successfully synced or still processing.' })
  @ApiResponse({ status: 400, description: 'Invalid request or API error.' })
  @ApiResponse({ status: 404, description: 'Destination not found.' })
  async syncId(@Param('destinationId') destinationId: string) {
    return await this.service.syncVideoId(destinationId);
  }
}
