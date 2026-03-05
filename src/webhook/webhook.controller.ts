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

    for (const entry of entries) {
      // 1) Messaging events (DMs)
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          const mid = m?.message?.mid; // stable Meta message id for dedupe
          const fallback = `${entry?.id ?? 'na'}-${m?.timestamp ?? Date.now()}-${m?.sender?.id ?? 'na'}`;
          const jobId = `meta-dm-${mid ?? fallback}`.replace(/:/g, '-');

          await this.inboxQueue.add(
            'meta-inbound-message',
            { entryId: entry.id, messaging: m, rawEntry: entry, objectType },
            {
              jobId,
              attempts: 15,
              backoff: { type: 'exponential', delay: 1500 },
              removeOnComplete: true,
              removeOnFail: { age: 7 * 24 * 3600 }, // keep fails for a week
            },
          );
        }
        continue;
      }

      // 2) Feed events (comments, etc.)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (change?.field !== 'feed') continue;

          // Try to build a stable id for job dedupe
          const changeId =
            change?.value?.comment_id ??
            change?.value?.post_id ??
            `${entry?.id ?? 'na'}-${change?.value?.item ?? 'feed'}-${change?.value?.verb ?? 'unknown'}-${change?.value?.created_time ?? Date.now()}`;

          await this.inboxQueue.add(
            'meta-inbound-comment',
            { entryId: entry.id, change, rawEntry: entry },
            {
              jobId: `meta-feed-${changeId}`.replace(/:/g, '-'),
              attempts: 15,
              backoff: { type: 'exponential', delay: 1500 },
              removeOnComplete: true,
              removeOnFail: { age: 7 * 24 * 3600 },
            },
          );
        }
        continue;
      }

      // 3) Everything else (permission changes, deauth, etc.) -> system queue
      await this.webhooksQueue.add(
        'meta-system-event',
        { entry },
        {
          jobId:
            `meta-system-${entry?.id ?? cryptoRandomId()}-${Date.now()}`.replace(
              /:/g,
              '-',
            ),
          attempts: 10,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      );
    }

    // Always respond fast
    return { status: 'success' };
  }

  @Get('linkedin')
  verifyLinkedIn(@Query('challengeCode') challengeCode: string) {
    if (!challengeCode) {
      throw new BadRequestException('Missing challengeCode');
    }

    const clientSecret = this.config.get<string>('LINKEDIN_CLIENT_SECRET');
    if (!clientSecret) {
      this.logger.error(
        'LINKEDIN_CLIENT_SECRET is missing in environment variables.',
      );
      throw new InternalServerErrorException('Webhook configuration error');
    }

    // 1. Create the Hex-encoded HMAC-SHA256 hash
    const challengeResponse = createHmac('sha256', clientSecret)
      .update(challengeCode)
      .digest('hex');

    // 2. Return the exact JSON structure LinkedIn requires
    // NestJS automatically sets Content-Type to application/json and returns a 200 OK.
    return {
      challengeCode,
      challengeResponse,
    };
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

    // Instantly offload the payload to BullMQ for the InboxProcessor to handle
    await this.inboxQueue.add(
      'linkedin-inbound-comment',
      { payload },
      {
        jobId: `linkedin-webhook-${notificationId}`,
        attempts: 15, // High retry count is great for network blips
        backoff: { type: 'exponential', delay: 1500 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );

    // Always respond quickly to prevent LinkedIn from blocking your endpoint
    return { status: 'success' };
  }
}

function cryptoRandomId() {
  // Lightweight unique suffix if entry.id is missing
  return Math.random().toString(36).slice(2);
}
