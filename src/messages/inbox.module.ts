import { forwardRef, Module } from '@nestjs/common';
import { InboxService } from './services/inbox-message.service';
import { InboxController } from './controller/inbox-message.controller';
import { EventsModule } from '@/events/events.module';
import { WorkerModule } from '@/worker/worker.module';
import { InboxIngestService } from './services/inbox-ingest.service';
import { TwitterAdapter } from './adapters/twitter.adapter';
import { MetaAdapter } from './adapters/meta.adapter';
import { MetaClient } from './integrations/meta.client';
import { TwitterClient } from './integrations/twitter.client';
import { InboxCommentsService } from './services/inbox-comments.service';
import { InboxCommentsController } from './controller/inbox-comments.controller';
import { EncryptionService } from '@/common/utility/encryption.service';
import { LinkedInAdapter } from './adapters/linkedIn.adapter';

@Module({
  imports: [EventsModule, forwardRef(() => WorkerModule)],
  controllers: [InboxController, InboxCommentsController],
  providers: [
    InboxService,
    InboxCommentsService,
    InboxIngestService,
    MetaAdapter,
    TwitterAdapter,
    LinkedInAdapter,
    MetaClient,
    TwitterClient,
    EncryptionService
  ],
  exports: [
    InboxIngestService,
    MetaAdapter,
    TwitterAdapter,
    LinkedInAdapter,
    MetaClient,
    TwitterClient,
  ],
})
export class InboxModule {}
