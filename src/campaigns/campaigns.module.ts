import { Module } from '@nestjs/common';
import { CampaignService } from './campaigns.service';
import { CampaignController } from './campaigns.controller';

@Module({
  controllers: [CampaignController],
  providers: [CampaignService],
})
export class CampaignsModule {}
