import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { HttpModule } from '@nestjs/axios';
import { BillingPublicController } from './public-billing.controller';

@Module({
  imports: [HttpModule],
  controllers: [BillingController, BillingPublicController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
