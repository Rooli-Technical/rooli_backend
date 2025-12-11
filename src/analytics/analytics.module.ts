import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AiInsightsService } from './services/ai-insights.service';
import { ExportService } from './services/export.service';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { AnalyticsPageService } from './services/analytics-page.service';
import { AnalyticsPostService } from './services/analytics-post.service';
import { AnalyticsProcessor } from './services/analytics.processor';
import { AnalyticsWorkerService } from './services/analytics.worker';
import { AnalyticsQueueEvents } from './services/analytics.listener';
import { AnalyticsService } from './services/analytics.service';
import { EncryptionService } from '@/common/utility/encryption.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'analytics-queue',
      defaultJobOptions: {
        attempts: 3, // If FB fails, try 3 times
        backoff: {
          type: 'exponential',
          delay: 5000, // Wait 5s, then 20s, then 80s...
        },
        removeOnComplete: true,
      },
    }),
    HttpModule,
  ],
  controllers: [AnalyticsController],
  providers: [
    AiInsightsService,
    ExportService,
    AnalyticsPageService,
    AnalyticsPostService,
    AnalyticsProcessor,
    AnalyticsWorkerService,
    AnalyticsQueueEvents,
    AnalyticsService,
    EncryptionService
  ],
})
export class AnalyticsModule {}
