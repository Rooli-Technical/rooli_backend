import { Module } from '@nestjs/common';
import { InboxService } from './services/inbox.service';
import { InboxController } from './inbox.controller';
import { InboxMessagesService } from './services/inbox-messages.service';
import { EventsModule } from '@/events/events.module';
import { WorkerModule } from '@/worker/worker.module';

@Module({
  imports: [EventsModule, WorkerModule],
  controllers: [InboxController],
  providers: [InboxService, InboxMessagesService],
})
export class InboxModule {}
