import { Module } from '@nestjs/common';
import { WorkerService } from './worker.service';
import { WorkerController } from './worker.controller';
import { BullModule } from '@nestjs/bullmq';
import { PostMediaModule } from '@/post-media/post-media.module';
import { MediaIngestProcessor } from './processors/media-ingest.processor';
import { SocialModule } from '@/social/social.module';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PublishPostProcessor } from './processors/publish-post.processor';

@Module({
  imports: [
   BullModule.registerQueue(
      { name: 'media-ingest' },
      { name: 'publishing-queue' }
    ),
    PostMediaModule,
    SocialModule,
  ],
  controllers: [WorkerController],
  providers: [
    WorkerService,
    MediaIngestProcessor,
    PublishPostProcessor,
    EncryptionService,
  ],
  exports: [
    BullModule, 
  ],
})
export class WorkerModule {}
