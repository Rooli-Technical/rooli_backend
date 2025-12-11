import {
  Controller,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';

import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AnalyticsService } from './services/analytics.service';

@ApiTags('Analytics')
@ApiBearerAuth()
  @Controller('api/v1/analytics')
export class AnalyticsController {

constructor(private readonly service: AnalyticsService) {}

// @Get('dashboard')
//   async getDashboard(@Req() req, @Query('days') days: string = '30') {
//     const { orgId } = req.user;
//     const daysCount = parseInt(days) || 30;

//     return this.service.getDashboard(orgId, daysCount);
//   }

    @Get(':id/stats')
  @ApiOperation({
    summary: 'Get organization statistics',
    description:
      'Returns statistics about engagement, AI generations, scheduled posts, and team members.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization stats retrieved',
  })
  async getStats(
    @Req() req,
    @Param('id') orgId: string,
  ) {
    return this.service.getOrganizationStats(orgId, req.user.id);
  }
}