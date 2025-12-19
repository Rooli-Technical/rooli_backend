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
    // 1. Log Raw Data
    const log = await this.prisma.webhookLog.create({
      data: {
        provider: 'META',
        eventType: payload.object === 'page' ? 'page_update' : 'permissions_revoked',
        // Meta sends a batch of entries, we just log the raw body
        payload: payload, 
        status: 'PENDING',
      }
    });

    // 2. Offload to Worker
    await this.webhooksQueue.add('meta-event', {
      logId: log.id,
      data: payload
    });

    return { status: 'success' };
  }

}
