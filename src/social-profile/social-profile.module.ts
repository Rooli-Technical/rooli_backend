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

@Module({
  imports: [SocialConnectionModule, HttpModule],
  controllers: [SocialProfileController],
  providers: [
    SocialProfileService,
    SocialConnectionService,
    EncryptionService,
    FacebookService,
    LinkedInService,
    TwitterService
  ],
})
export class SocialProfileModule {}
