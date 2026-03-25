import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksProcessor } from './webhook-processor.service';
import { BillingModule } from '@/billing/billing.module';
import { WorkerModule } from '@/worker/worker.module';
import { EncryptionService } from '@/common/utility/encryption.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'webhooks', 
    }),
    BillingModule,
    WorkerModule
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhooksProcessor,
    EncryptionService
  ],
})
export class WebhookModule {}
