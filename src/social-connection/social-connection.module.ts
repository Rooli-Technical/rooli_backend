import { Module } from '@nestjs/common';
import { SocialConnectionService } from './social-connection.service';
import { SocialConnectionController } from './social-connection.controller';
import { EncryptionService } from '@/common/utility/encryption.service';
import { FacebookService } from './providers/facebook.service';
import { HttpModule } from '@nestjs/axios';
import { LinkedInService } from './providers/linkedin.service';
import { TwitterService } from './providers/twitter.service';

@Module({
  imports: [HttpModule],
  controllers: [SocialConnectionController],
  providers: [SocialConnectionService, EncryptionService, FacebookService, LinkedInService, TwitterService],
  exports:[SocialConnectionService]
})
export class SocialConnectionModule {}
