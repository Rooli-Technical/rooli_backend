import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsProcessor } from './analytics.processor';
import { AnalyticsScheduler } from './analytics.scheduler';
import { FacebookPageStrategy } from './strategies/facebook/facebook-page.strategy';
import { FacebookPostStrategy } from './strategies/facebook/facebook-post.strategy';
import { InstagramPageStrategy } from './strategies/instagram/instagram-page.strategy';
import { InstagramPostStrategy } from './strategies/instagram/instagram-post.strategy';
import { LinkedinPageStrategy } from './strategies/linkedin/linkedIn-page.strategy';
import { LinkedinPostStrategy } from './strategies/linkedin/linkedIn-post.strategy';
import { TwitterPageStrategy } from './strategies/twitter/twitter-page.strategy';
import { TwitterPostStrategy } from './strategies/twitter/twitter-post.strategy';

@Module({
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsService,
    AnalyticsScheduler,
    AnalyticsProcessor,
    TwitterPostStrategy,
    TwitterPageStrategy,
    FacebookPostStrategy,
    FacebookPageStrategy,
    InstagramPostStrategy,
    InstagramPageStrategy,
    LinkedinPostStrategy,
    LinkedinPageStrategy,
  ],
})
export class AnalyticsModule {}
