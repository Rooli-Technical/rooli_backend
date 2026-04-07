import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { SocialHealthService } from './social-health.service';
import { Platform } from '@generated/enums';
import { AdminJwtGuard } from '@/admin/guards/admin-jwt.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { QueryPostDto } from './social-health.dto';

@ApiTags('Admin-Social-Health')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard)
@Controller('admin/social-health')
export class SocialHealthController {
  constructor(private readonly service: SocialHealthService) {}

  // Platform API Health
  @Get('platform-health')
  getPlatformHealth() {
    return this.service.getPlatformHealth();
  }

  // Dead-Letter Queue
  @Get('dead-letter-queue')
  getDeadLetterQueue(@Query() query: QueryPostDto) {
    return this.service.failedPostJobs(query);
  }

}