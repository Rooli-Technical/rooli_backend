import { Module } from '@nestjs/common';
import { LinkedInService } from './linkedIn.service';
import { LinkedinController } from './linkedin.controller';
import { EncryptionService } from 'src/common/utility/encryption.service';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [HttpModule],
  controllers: [LinkedinController],
  providers: [LinkedInService, EncryptionService],
})
export class LinkedinModule {}
