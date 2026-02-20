import { Module } from '@nestjs/common';
import { InboxService } from './services/inbox.service';
import { InboxController } from './inbox.controller';

@Module({
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
