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
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Response } from 'express';
import { createHmac } from 'crypto';
import { Public } from '@/common/decorators/public.decorator';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PaystackWebhookGuard } from './guards/paystack.guard';
import { MetaWebhookGuard } from './guards/meta.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { LinkedInWebhookGuard } from './guards/linkedin.guard';
import { TikTokWebhookGuard } from './guards/tiktok.guard';

@Controller('webhooks')
@Public()
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @InjectQueue('webhooks') private readonly webhooksQueue: Queue,
    @InjectQueue('inbox-webhooks') private readonly inboxQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

  /**
   * Meta webhook verification endpoint.
   * Meta sends: hub.mode, hub.verify_token, hub.challenge
   */
  @Get('meta')
  verify(@Query() query: any, @Res() res: Response) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    const expectedToken = this.config.get<string>('META_VERIFY_TOKEN');

    if (
      mode === 'subscribe' &&
      token &&
      expectedToken &&
      token === expectedToken
    ) {
      return res.status(HttpStatus.OK).send(challenge);
    }

    return res.status(HttpStatus.FORBIDDEN).send();
  }

  /**
   * Meta webhook receiver.
   * - Guard verifies x-hub-signature-256 using raw body + META_APP_SECRET.
   * - We immediately enqueue each sub-event as its own job with a stable jobId.
   */
@Post('meta')
  @UseGuards(MetaWebhookGuard)
  async handle(@Body() payload: any) {
    const objectType = payload?.object;
    const entries = payload?.entry ?? [];


    const log = await this.prisma.webhookLog.create({
      data: {
        provider: 'META',
        eventType: objectType, 
        resourceId: entries[0]?.id || 'system-event',
        payload: payload,
        status: 'PENDING',
      },
    });

    for (const entry of entries) {
      // ==========================================
      // 1. STANDARD MESSAGING (FB Pages & Linked IG)
      // ==========================================
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          await this.queueMessage(entry, m, objectType);
        }
        continue;
      }

      // ==========================================
      // 2. CHANGES ARRAY (Standalone IG & Feeds)
      // ==========================================
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          
          // A. Standalone IG Direct Messages
          if (change.field === 'messages') {
            const m = change.value; // The value object perfectly mirrors the old 'messaging' object
            await this.queueMessage(entry, m, objectType);
            continue;
          }

          // B. Feed / Comments (FB & IG)
          if (change.field === 'feed' || change.field === 'comments') {
            const changeId =
              change?.value?.id ??           // <-- Catches Instagram Comments
              change?.value?.comment_id ??   // <-- Catches Facebook Comments
              change?.value?.post_id ??
              `${entry?.id ?? 'na'}-${change.field}-${Date.now()}`;

            await this.inboxQueue.add(
              'meta-inbound-comment',
              { entryId: entry.id, change, rawEntry: entry, objectType },
              {
                jobId: `meta-feed-${changeId}`.replace(/:/g, '-'),
                attempts: 5,
                backoff: { type: 'exponential', delay: 1500 },
                removeOnComplete: true,
              },
            );
            continue;
          }
        }
        continue;
      }

      // ==========================================
      // 3. SYSTEM EVENTS
      // ==========================================
      await this.webhooksQueue.add(
        'meta-system-event',
        { entry },
        {
          jobId: `meta-system-${entry?.id ?? cryptoRandomId()}-${Date.now()}`.replace(/:/g, '-'),
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      );
    }

    return { status: 'success' };
  }

  // Extracted into a helper method to keep your controller clean since we call it twice
  private async queueMessage(entry: any, m: any, objectType: string) {
    const mid = m?.message?.mid; 
    const fallback = `${entry?.id ?? 'na'}-${m?.timestamp ?? Date.now()}-${m?.sender?.id ?? 'na'}`;
    const jobId = `meta-dm-${mid ?? fallback}`.replace(/:/g, '-');
    
    this.logger.log(`Adding DM to queue: ${jobId}`);
    
    await this.inboxQueue.add(
      'meta-inbound-message',
      { entryId: entry.id, messaging: m, rawEntry: entry, objectType }, // Pass 'm' as 'messaging' for the adapter
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1500 },
        removeOnComplete: true,
      },
    );
  }

  // @Get('linkedin')
  // verifyLinkedIn(@Query('challengeCode') challengeCode: string) {
  //   if (!challengeCode) {
  //     throw new BadRequestException('Missing challengeCode');
  //   }

  //   const clientSecret = this.config.get<string>('LINKEDIN_APP_ID');
  //   if (!clientSecret) {
  //     this.logger.error(
  //       'LINKEDIN_LINKEDIN_APP_ID is missing in environment variables.',
  //     );
  //     throw new InternalServerErrorException('Webhook configuration error');
  //   }

  //   // 1. Create the Hex-encoded HMAC-SHA256 hash
  //   const challengeResponse = createHmac('sha256', clientSecret)
  //     .update(challengeCode)
  //     .digest('hex');

  //   // 2. Return the exact JSON structure LinkedIn requires
  //   // NestJS automatically sets Content-Type to application/json and returns a 200 OK.
  //   return {
  //     challengeCode,
  //     challengeResponse,
  //   };
  // }

  @Get('linkedin')
  verifyLinkedIn(@Query('challengeCode') challengeCode: string, @Res() res: Response) {
    if (!challengeCode) {
      throw new BadRequestException('Missing challengeCode');
    }

    this.logger.log(`[LinkedIn] Handshake received: ${challengeCode}`);

    // ✅ FIX: LinkedIn expects the challengeCode returned as PLAIN TEXT 
    // with a 200 OK status. Do not return JSON.
    return res.status(200).set('Content-Type', 'text/plain').send(challengeCode);
  }

  /**
   * LinkedIn webhook receiver.
   * LinkedIn sends actual live comment data here via POST.
   */
  @Post('linkedin')
  @UseGuards(LinkedInWebhookGuard)
  async handleLinkedIn(@Body() payload: any) {
    // LinkedIn includes a unique notificationId to help you deduplicate
    const notificationId = payload?.notificationId || cryptoRandomId();

    const log = await this.prisma.webhookLog.create({
      data: {
        provider: 'LINKEDIN',
        eventType: 'notification',
        resourceId: notificationId,
        payload: payload,
        status: 'PENDING',
      },
    });

    // Instantly offload the payload to BullMQ for the InboxProcessor to handle
    await this.inboxQueue.add(
      'linkedin-inbound-comment',
      { payload },
      {
        jobId: `linkedin-webhook-${notificationId}`,
        attempts: 5, 
        backoff: { type: 'exponential', delay: 1500 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );

    // Always respond quickly to prevent LinkedIn from blocking your endpoint
    return { status: 'success' };
  }

  // ==========================================
  // 4. TIKTOK 
  // ==========================================

  /**
   * TikTok webhook receiver.
   * TikTok does NOT use a GET handshake. They only send POST requests
   * secured by the X-Tiktok-Signature header.
   */
  @Post('tiktok')
  @UseGuards(TikTokWebhookGuard) 
  async handleTikTok(@Body() payload: any) {
    // TikTok sends the event name in the "event" property
    const eventType = payload?.event || 'unknown';
    const openId = payload?.user_openid || 'system-event';

    this.logger.log(`[TikTok] Webhook received: ${eventType} for User: ${openId}`);

    // 1. Log to Database
    const log = await this.prisma.webhookLog.create({
      data: {
        provider: 'TIKTOK',
        eventType: eventType,
        resourceId: openId, 
        payload: payload,
        status: 'PENDING',
      },
    });

    // 2. Route based on the Event Type
    if (eventType === 'post.publish.complete' || eventType === 'post.publish.failed') {
      await this.webhooksQueue.add(
        'tiktok-publish-status',
        { logId: log.id, payload },
        {
          jobId: `tiktok-publish-${payload?.content?.publish_id || log.id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      );
    } else if (eventType === 'authorization.removed') {
      await this.webhooksQueue.add(
        'tiktok-deauth',
        { logId: log.id, payload },
        {
          jobId: `tiktok-deauth-${openId}`,
          attempts: 3,
          removeOnComplete: true,
        },
      );
    }

    // 3. TikTok requires a 200 OK response within 3 seconds, or they will retry!
    return { status: 'success' };
  }
}

function cryptoRandomId() {
  // Lightweight unique suffix if entry.id is missing
  return Math.random().toString(36).slice(2);
}
