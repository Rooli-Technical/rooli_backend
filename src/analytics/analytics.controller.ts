import { Controller, Get, Query, Req } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  async getDashboardOverview(
    @Req() req,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    // 1. Extract Organization ID
    // Assuming your AuthGuard attaches the user & org to req.user
    const organizationId = req.user.organizationId; 

    
    // Default dates
    const startDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = to ? new Date(to) : new Date();

    return this.analyticsService.getDashboardOverview(
        organizationId, 
        startDate, 
        endDate
    );
  }
}
