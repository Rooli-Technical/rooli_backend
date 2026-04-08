import { Module } from '@nestjs/common';
import { PlanAccessServiceController } from './plan-access-service.controller';
import { PlanAccessService } from './plan-access-service.service';

@Module({
  controllers: [PlanAccessServiceController],
  providers: [PlanAccessService],
  exports: [PlanAccessService],
})
export class PlanAccessServiceModule {}
