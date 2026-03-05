import { Module } from '@nestjs/common';
import { PollingService } from './polling.service';
import { PollingController } from './polling.controller';
import { InstagramInboxProvider } from './providers/instagram-inbox.provider';
import { MetaInboxProvider } from './providers/meta-inbox.provider';
import { LinkedInInboxProvider } from './providers/linkedin-inbox.provider';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports:[HttpModule],
  controllers: [PollingController],
  providers: [PollingService, InstagramInboxProvider, MetaInboxProvider, LinkedInInboxProvider],
})
export class PollingModule {}
