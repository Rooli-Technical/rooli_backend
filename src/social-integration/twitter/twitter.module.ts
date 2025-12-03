import { Module } from '@nestjs/common';
import { TwitterService } from './twitter.service';
import { TwitterController } from './twitter.controller';
import { HttpModule } from '@nestjs/axios';
import { EncryptionService } from '@/common/utility/encryption.service';

@Module({
  imports: [
    HttpModule,
  ],
  controllers: [TwitterController],
  providers: [TwitterService, EncryptionService],
})
export class TwitterModule {}
