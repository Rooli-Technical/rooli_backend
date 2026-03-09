import { forwardRef, Module } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { WorkerController } from './worker.controller';
import { BullModule } from '@nestjs/bullmq';
import { PostMediaModule } from '@/post-media/post-media.module';
import { MediaIngestProcessor } from './processors/media-ingest.processor';
import { SocialModule } from '@/social/social.module';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PublishPostProcessor } from './processors/publish-post.processor';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsModule } from '@/analytics/analytics.module';
import { EventsModule } from '@/events/events.module';
import { InboundWebhooksProcessor } from './processors/inbound-webhooks.processor';
import { OutboundMessagesProcessor } from './processors/outbound-messages.processor';
import { InboxModule } from '@/messages/inbox.module';
import { InboxSyncProcessor } from './processors/polling.processor';
import { PollingModule } from '@/polling/polling.module';
import { RedisModule } from '@/redis/redis.module';

@Module({
  imports: [
   BullModule.registerQueue(
      { name: 'media-ingest' },
      { name: 'publishing-queue' },
      { name: 'inbox-webhooks' },
      { name: 'outbound-messages' },
    ),
    PostMediaModule,
    SocialModule,
    AnalyticsModule,
    EventsModule,
    PollingModule,
    forwardRef(() => InboxModule),
    forwardRef(() => PollingModule),
    RedisModule, 
  ],
  controllers: [WorkerController],
  providers: [
    WorkerService,
    MediaIngestProcessor,
    PublishPostProcessor,
    EncryptionService,
    AnalyticsProcessor,
    InboundWebhooksProcessor,
    OutboundMessagesProcessor,
    InboxSyncProcessor
  ],
  exports: [
    BullModule, 
  ],
})
export class WorkerModule {}
