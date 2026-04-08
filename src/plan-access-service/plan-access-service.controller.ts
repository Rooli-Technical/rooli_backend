import { Controller } from '@nestjs/common';
import { PlanAccessService } from './plan-access-service.service';

@Controller('plan-access-service')
export class PlanAccessServiceController {
  constructor(private readonly planAccessService: PlanAccessService) {}
}
