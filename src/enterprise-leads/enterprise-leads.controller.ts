import { Controller } from '@nestjs/common';
import { EnterpriseLeadsService } from './enterprise-leads.service';

@Controller('enterprise-leads')
export class EnterpriseLeadsController {
  constructor(private readonly enterpriseLeadsService: EnterpriseLeadsService) {}
}
