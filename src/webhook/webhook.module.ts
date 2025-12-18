import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksProcessor } from './webhook-processor.service';
import { BillingModule } from '@/billing/billing.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'webhooks', 
    }),
    BillingModule
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhooksProcessor,
  ],
})
export class WebhookModule {}
