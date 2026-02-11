import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CampaignService } from './campaigns.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { CreateCampaignDto } from './dto/request/create-campaign.dto';
import { UpdateCampaignDto } from './dto/request/update-campaign.dto';
import { CampaignStatus } from '@generated/enums';
import { RequireFeature } from '@/common/decorators/require-feature.decorator';
import { FeatureGuard } from '@/common/guards/feature.guard';

@ApiTags('Campaigns')
@ApiBearerAuth()
@Controller('/api/v1/workspaces/:workspaceId/campaigns')
@UseGuards(FeatureGuard)
@RequireFeature('hasCampaigns')
export class CampaignController {
  constructor(private readonly service: CampaignService) {}

  @Post()
  @ApiOperation({ summary: 'Create campaign' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  create(@Param('workspaceId') workspaceId: string, @Body() dto: CreateCampaignDto) {
    return this.service.create(workspaceId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List campaigns' })
  @ApiParam({ name: 'workspaceId', example: 'ws_123' })
  @ApiQuery({ name: 'status', required: false, enum: CampaignStatus })
  list(@Param('workspaceId') workspaceId: string, @Query('status') status?: CampaignStatus) {
    return this.service.list(workspaceId, status);
  }

  @Get(':campaignId')
  @ApiOperation({ summary: 'Get campaign' })
  get(@Param('workspaceId') workspaceId: string, @Param('campaignId') campaignId: string) {
    return this.service.get(workspaceId, campaignId);
  }

  @Patch(':campaignId')
  @ApiOperation({ summary: 'Update campaign' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.service.update(workspaceId, campaignId, dto);
  }

  @Delete(':campaignId')
  @ApiOperation({ summary: 'Delete campaign (detach posts or block if used)' })
  @ApiQuery({ name: 'mode', required: false, enum: ['detach', 'block'], example: 'detach' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @Query('mode') mode?: 'detach' | 'block',
  ) {
    return this.service.delete(workspaceId, campaignId, mode ?? 'detach');
  }

  @Get(':campaignId/posts')
  @ApiOperation({ summary: 'List posts in campaign' })
  listPosts(@Param('workspaceId') workspaceId: string, @Param('campaignId') campaignId: string) {
    return this.service.listPosts(workspaceId, campaignId);
  }

  @Get(':id/analytics')
  @ApiOperation({ summary: 'Get aggregated stats for this campaign' })
  analytics(@Param('workspaceId') wsId: string, @Param('id') id: string) {
    return this.service.getCampaignAnalytics(wsId, id);
  }
}
