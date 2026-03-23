import { Module } from '@nestjs/common';
import { AnalyticsService } from './services/analytics.service';
import { AnalyticsController } from './analytics.controller';
import { EncryptionService } from '@/common/utility/encryption.service';
import { TwitterAnalyticsProvider } from './providers/twitter.provider';
import { LinkedInAnalyticsProvider } from './providers/linkedin.provider';
import { FacebookAnalyticsProvider } from './providers/facebook-analytics.provider';
import { InstagramAnalyticsProvider } from './providers/instagram-analytics.provider';
import { HttpModule } from '@nestjs/axios';
import { AnalyticsNormalizerService } from './services/analytics-normalizer.service';
import { AnalyticsRepository } from './services/analytics.repository';
import { AnalyticsScheduler } from './scheduler/analytics.scheduler';
import { BullModule } from '@nestjs/bullmq';
import { TikTokAnalyticsProvider } from './providers/tiktok-anlytics.provider';

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue({
      name: 'analytics-queue',
    }),
  ],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    EncryptionService,
    TwitterAnalyticsProvider,
    LinkedInAnalyticsProvider,
    FacebookAnalyticsProvider,
    TikTokAnalyticsProvider,
    InstagramAnalyticsProvider,
    AnalyticsService,
    AnalyticsNormalizerService,
    AnalyticsRepository,
    AnalyticsScheduler,
  ],
  exports: [AnalyticsService, AnalyticsNormalizerService, AnalyticsRepository, BullModule],
})
export class AnalyticsModule {}
