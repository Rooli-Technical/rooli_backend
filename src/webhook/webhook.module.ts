import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksProcessor } from './webhook-processor.service';
import { BillingModule } from '@/billing/billing.module';
import { WorkerModule } from '@/worker/worker.module';
import { EncryptionService } from '@/common/utility/encryption.service';
import { EventsModule } from '@/events/events.module';
import { TikTokPublishReconciliationService } from './tiktok-publish-reconciliation.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'webhooks',
    }),
    BillingModule,
    WorkerModule,
    EventsModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhooksProcessor,
    EncryptionService,
    TikTokPublishReconciliationService,
  ],
})
export class WebhookModule {}
