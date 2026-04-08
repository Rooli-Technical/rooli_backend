import { Module } from '@nestjs/common';
import { SocialConnectionService } from './social-connection.service';
import { SocialConnectionController } from './social-connection.controller';
import { EncryptionService } from '@/common/utility/encryption.service';
import { FacebookService } from './providers/facebook.service';
import { HttpModule } from '@nestjs/axios';
import { LinkedInService } from './providers/linkedin.service';
import { TwitterService } from './providers/twitter.service';
import { InstagramService } from './providers/instagram.service';
import { TikTokService } from './providers/tiktok.service';
import { PlanAccessModule } from '@/plan-access-service/plan-access.module';

@Module({
  imports: [HttpModule, PlanAccessModule],
  controllers: [SocialConnectionController],
  providers: [
    SocialConnectionService,
    EncryptionService,
    FacebookService,
    LinkedInService,
    TwitterService,
    InstagramService,
    TikTokService,
  ],
  exports: [SocialConnectionService],
})
export class SocialConnectionModule {}
