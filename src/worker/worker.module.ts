import { Module } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { WorkerController } from './worker.controller';
import { BullModule } from '@nestjs/bullmq';
import { PostMediaModule } from '@/post-media/post-media.module';
import { MediaIngestProcessor } from './processors/media-ingest.processor';
import { SocialModule } from '@/social/social.module';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PublishPostProcessor } from './processors/publish-post.processor';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsNormalizerService } from '@/analytics/services/analytics-normalizer.service';
import { AnalyticsRepository } from '@/analytics/services/analytics.repository';
import { AnalyticsService } from '@/analytics/services/analytics.service';
import { AnalyticsModule } from '@/analytics/analytics.module';

@Module({
  imports: [
   BullModule.registerQueue(
      { name: 'media-ingest' },
      { name: 'publishing-queue' },
      { name: 'analytics-queue' }
    ),
    PostMediaModule,
    SocialModule,
    AnalyticsModule,
  ],
  controllers: [WorkerController],
  providers: [
    WorkerService,
    MediaIngestProcessor,
    PublishPostProcessor,
    EncryptionService,
    AnalyticsProcessor
  ],
  exports: [
    BullModule, 
  ],
})
export class WorkerModule {}
