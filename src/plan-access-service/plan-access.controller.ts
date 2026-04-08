import { Controller } from '@nestjs/common';
import { PlanAccessService } from './plan-access.service';

@Controller('plan-access')
export class PlanAccessController {
  constructor(private readonly planAccessService: PlanAccessService) {}
}
