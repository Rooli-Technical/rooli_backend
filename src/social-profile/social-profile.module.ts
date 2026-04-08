import { Module } from '@nestjs/common';
import { SocialProfileService } from './social-profile.service';
import { SocialProfileController } from './social-profile.controller';
import { SocialConnectionModule } from '@/social-connection/social-connection.module';
import { SocialConnectionService } from '@/social-connection/social-connection.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { FacebookService } from '@/social-connection/providers/facebook.service';
import { HttpModule } from '@nestjs/axios';
import { LinkedInService } from '@/social-connection/providers/linkedin.service';
import { TwitterService } from '@/social-connection/providers/twitter.service';
import { InstagramService } from '@/social-connection/providers/instagram.service';
import { EventsModule } from '@/events/events.module';
import { TikTokService } from '@/social-connection/providers/tiktok.service';
import { PlanAccessModule } from '@/plan-access-service/plan-access.module';

@Module({
  imports: [SocialConnectionModule, HttpModule, EventsModule, PlanAccessModule],
  controllers: [SocialProfileController],
  providers: [
    SocialProfileService,
    SocialConnectionService,
    EncryptionService,
    FacebookService,
    LinkedInService,
    TwitterService,
    InstagramService,
    TikTokService,
  ],
})
export class SocialProfileModule {}
