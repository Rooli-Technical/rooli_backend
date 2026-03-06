import { Module } from '@nestjs/common';
import { PollingService } from './polling.service';
import { PollingController } from './polling.controller';
import { InstagramInboxProvider } from './providers/instagram-inbox.provider';
import { MetaInboxProvider } from './providers/meta-inbox.provider';
import { LinkedInInboxProvider } from './providers/linkedin-inbox.provider';
import { HttpModule } from '@nestjs/axios';
import { InboxSyncScheduler } from './schedulers/polling.scheduler';
import { WorkerModule } from '@/worker/worker.module';
import { BullModule } from '@nestjs/bullmq';
import { forwardRef } from '@nestjs/common';

@Module({
  imports: [
    HttpModule,
    forwardRef(() => WorkerModule),
    BullModule.registerQueue({
      name: 'inbox-sync',
    }),
  ],
  controllers: [PollingController],
  providers: [
    PollingService,
    InstagramInboxProvider,
    MetaInboxProvider,
    LinkedInInboxProvider,
    InboxSyncScheduler,
  ],
  exports: [InstagramInboxProvider, MetaInboxProvider, LinkedInInboxProvider],
})
export class PollingModule {}
