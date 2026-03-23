import { Injectable, BadRequestException } from '@nestjs/common';
import { TwitterProvider } from './providers/twitter.provider';
import { ISocialProvider } from './interfaces/social-provider.interface';
import { FacebookProvider } from './providers/facbook.provider';
import { InstagramProvider } from './providers/instagram.provider';
import { LinkedInProvider } from './providers/linkedin.provider';
import { Platform } from '@generated/enums';
import { TikTokProvider } from './providers/tiktok.provider';

@Injectable()
export class SocialFactory {
  constructor(
    private twitter: TwitterProvider,
    private linkedin: LinkedInProvider,
    private facebook: FacebookProvider,
    private instagram: InstagramProvider,
    private tiktok: TikTokProvider,

  ) {}

  getProvider(platform: Platform): ISocialProvider {
    switch (platform) {
      case 'TWITTER':
        return this.twitter;
      case 'LINKEDIN':
        return this.linkedin;
      case 'FACEBOOK': 
        return this.facebook;
      case 'INSTAGRAM': 
        return this.instagram;
      case 'TIKTOK':
        return this.tiktok;
      default:
        throw new BadRequestException(`Platform ${platform} is not supported yet.`);
    }
  }
}