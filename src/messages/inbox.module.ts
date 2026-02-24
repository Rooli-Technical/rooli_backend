import { forwardRef, Module } from '@nestjs/common';
import { InboxService } from './services/inbox.service';
import { InboxController } from './inbox.controller';
import { InboxMessagesService } from './services/inbox-messages.service';
import { EventsModule } from '@/events/events.module';
import { WorkerModule } from '@/worker/worker.module';
import { InboxIngestService } from './services/inbox-ingest.service';
import { TwitterAdapter } from './adapters/twitter.adapter';
import { MetaAdapter } from './adapters/meta.adapter';
import { MetaClient } from './integrations/meta.client';
import { TwitterClient } from './integrations/twitter.client';

@Module({
  imports: [EventsModule, forwardRef(() => WorkerModule)],
  controllers: [InboxController],
  providers: [
    InboxService,
    InboxMessagesService,
    InboxIngestService,
    MetaAdapter,
    TwitterAdapter,
    MetaClient,
    TwitterClient
  ],
  exports: [InboxIngestService, MetaAdapter, TwitterAdapter, MetaClient, TwitterClient],
})
export class InboxModule {}
