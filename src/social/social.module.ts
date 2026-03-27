import { Module } from '@nestjs/common';
import { TwitterProvider } from './providers/twitter.provider';
import { SocialFactory } from './social.factory';
import { LinkedInProvider } from './providers/linkedin.provider';
import { FacebookProvider } from './providers/facbook.provider';
import { InstagramProvider } from './providers/instagram.provider';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue({ name: 'post-verification' }),
  ],
  providers: [
    SocialFactory,
    TwitterProvider,
    LinkedInProvider,
    FacebookProvider,
    InstagramProvider,
  ],
  exports: [SocialFactory, FacebookProvider],
})
export class SocialModule {}
