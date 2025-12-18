import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksProcessor } from './webhook-processor.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'webhooks', 
    }),
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhooksProcessor,
  ],
})
export class WebhookModule {}
