import { Module } from '@nestjs/common';
import { TwitterProvider } from './providers/twitter.provider';
import { SocialFactory } from './social.factory';
import { LinkedInProvider } from './providers/linkedin.provider';
import { FacebookProvider } from './providers/facbook.provider';
import { InstagramProvider } from './providers/instagram.provider';

@Module({
  providers: [SocialFactory, TwitterProvider, LinkedInProvider, FacebookProvider, InstagramProvider],
  exports: [SocialFactory],
})
export class SocialModule {}
