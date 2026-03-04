import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsScheduler } from './scheduler/analytics.scheduler';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiOkResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { subDays } from 'date-fns/subDays';

@Controller('analytics')
@ApiBearerAuth()
@ApiTags('Analytics (Admin / Debug)')
export class AnalyticsController {
  constructor(private readonly scheduler: AnalyticsScheduler, private readonly service: AnalyticsService) {}

  
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
        description: 'Optional internal Post Destination ID to fetch analytics for',
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
  async testFetch(@Body() body: {profileId: string; postDestinationId?: string } ){
    await this.service.testFetch(body)

  }

  @Get('account/:profileId')
  @ApiOperation({ summary: 'Get account performance history (followers, views, etc.)' })
  @ApiQuery({ name: 'days', required: false, description: 'Lookback window (default 30)' })
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
  @ApiQuery({ name: 'days', required: false, description: 'Lookback window (default 30)' })
  async getPostStats(
    @Param('postDestinationId',) postDestinationId: string,
    @Query('days') days?: number,
  ){
    const lookback = days ? Number(days) : 30;
    const end = new Date();
    const start = subDays(end, lookback);

    return this.service.getPostHistory(postDestinationId, start, end);
  }

 @Get('/workspaces/:id/dashboard')
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
  async getWorkspaceDashboard(
    @Param('id') workspaceId: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Req() req?: any,
  ) {
    if (days < 1) throw new BadRequestException('days must be >= 1');
    return this.service.getWorkspaceDashboard(workspaceId, req?.user?.userPlan, days);
  }

@Get('profile/:profileId/dashboard')
  @ApiOperation({ 
    summary: 'Get detailed dashboard data for a specific social profile',
    description: 'Returns historical account growth, demographics, and top performing posts.'
  })
  @ApiParam({ name: 'profileId', description: 'The UUID of the social profile' })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 30 })
  @ApiResponse({ status: 200, description: 'Unified analytics payload returned successfully.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async getProfileDashboard(
    @Param('profileId') profileId: string,
    @Query('days') days?: string,
  ) {
    // Note: Query params come in as strings, so we parse to number
    const daysCount = days ? parseInt(days, 10) : 30;
    return this.service.getProfileDashboard(profileId, daysCount);
  }

  @Get(':workspaceId/dashboard/posts')
  @ApiOperation({ 
    summary: 'Get recent successful platform posts with latest analytics' 
  })
  @ApiResponse({ 
    status: 200, 
    description: 'List of dashboard posts across all platforms' 
  })
  async getRecentPublished(
    @Param('workspaceId') workspaceId: string,
  ){
    return this.service.getDashboardPosts(workspaceId);
  }
}
