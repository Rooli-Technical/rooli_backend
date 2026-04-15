import { Global, Module } from '@nestjs/common';
import { PlanAccessController } from './plan-access.controller';
import { PlanAccessService } from './plan-access.service';

@Global()
@Module({
  controllers: [PlanAccessController],
  providers: [PlanAccessService],
  exports: [PlanAccessService],
})
export class PlanAccessModule {}
