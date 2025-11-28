import { Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';
import { AccessControlController } from './access-control.controller';

@Module({
  controllers: [AccessControlController],
  providers: [AccessControlService],
})
export class AccessControlModule {}
