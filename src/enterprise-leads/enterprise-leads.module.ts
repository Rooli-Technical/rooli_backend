import { Module } from '@nestjs/common';
import { EnterpriseLeadsService } from './enterprise-leads.service';
import { EnterpriseLeadsController } from './enterprise-leads.controller';

@Module({
  controllers: [EnterpriseLeadsController],
  providers: [EnterpriseLeadsService],
})
export class EnterpriseLeadsModule {}
