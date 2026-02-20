import {
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  Get,
  Query,
  HttpStatus,
  Logger,
  Body,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '@/common/decorators/public.decorator';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PaystackWebhookGuard } from './guards/paystack.guard';
import { MetaWebhookGuard } from './guards/meta.guard';
import { PrismaService } from '@/prisma/prisma.service';

@Controller('webhooks')
@Public()
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @InjectQueue('webhooks') private readonly webhooksQueue: Queue,
    @InjectQueue('inbox-webhooks') private readonly inboxQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

// ==========================================
  // 1. Paystack(Billing)
  // ==========================================
  @Post('paystack')
@UseGuards(PaystackWebhookGuard)
async handlePaystack(@Body() payload: any) {
  // 1. Log Raw Data
  const log = await this.prisma.webhookLog.create({
    data: {
      provider: 'PAYSTACK',
      eventType: payload.event || 'charge.success',
      resourceId: payload.data?.reference,
      payload: payload, // Store full JSON
      status: 'PENDING',
    },
  });

  // 2. Offload to Worker Queue
  await this.webhooksQueue.add('paystack-event', {
    logId: log.id,
    data: payload,
  });

  return { status: 'success' };
}

  // ==========================================
  // 2. META (Social - De-auth)
  // ==========================================
  
  // Verification (GET)
  @Get('meta')
  verifyMeta(@Query() query: any, @Res() res: Response) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === this.config.get('META_WEBHOOK_VERIFY_TOKEN')) {
      return res.status(HttpStatus.OK).send(challenge);
    }
    return res.status(HttpStatus.FORBIDDEN).send();
  }

  // Event (POST)
  @Post('meta')
  @UseGuards(MetaWebhookGuard)
  async handleMetaEvents(@Body() payload: any) {
   // Meta groups events in an "entry" array
    const entries = payload.entry || [];

    for (const entry of entries) {
      // 1. Is this a Messaging Event (DM)?
      if (entry.messaging) {
        // Send to the fast, high-volume INBOX queue
        await this.inboxQueue.add('meta-inbound-message', entry, {
          removeOnComplete: true, // Don't bloat Redis
        });
        continue;
      }

      // 2. Is this a Feed Event (Comment)?
      if (entry.changes && entry.changes[0]?.field === 'feed') {
        await this.inboxQueue.add('meta-inbound-comment', entry, {
          removeOnComplete: true,
        });
        continue;
      }

      // 3. Is it an Account/System Event? (De-auth, permission changes)
      // We keep your existing logging logic for system events!
      const log = await this.prisma.webhookLog.create({
        data: {
          provider: 'META',
          eventType: 'system_update',
          payload: entry,
          status: 'PENDING',
        }
      });

      // Send to the strict, system queue
      await this.webhooksQueue.add('meta-system-event', {
        logId: log.id,
        data: entry
      });
    }

    // Always return 200 immediately
    return { status: 'success' };
  }

}
