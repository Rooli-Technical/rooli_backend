import { BillingService } from '@/billing/billing.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { Job } from 'bullmq';
import * as JSONBigInt from 'json-bigint';

const JSONBig = JSONBigInt({ storeAsString: true });

@Processor('webhooks')
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly encryptionService: EncryptionService,
  ) {
    super();
  }

  async process(job: Job<{ logId: string; data: any; payload: any }>) {
    const { logId, data, payload } = job.data;

    try {
      if (job.name === 'paystack-event') {
        await this.processPaystack(logId, data);
      } else if (job.name === 'tiktok-publish-status') {
        await this.processTikTokPublish(logId, payload);
      } else if (job.name === 'tiktok-deauth') {
        await this.processTikTokDeauth(logId, payload);
      }
    } catch (error) {
      this.logger.error(
        `Webhook Processing Failed [LogID: ${logId}]: ${error.message}`,
      );

      // Mark as Failed in DB so we can debug later
      await this.prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      });

      throw error; // Throwing ensures BullMQ will retry (if configured)
    }
  }

  // ==========================================
  // PAYSTACK LOGIC
  // ==========================================
  private async processPaystack(logId: string, payload: any) {
    const event = payload.event;
    const data = payload.data; // Helper to avoid payload.data everywhere
    const reference = data?.reference;
    let organizationId = payload.data?.metadata?.organizationId;

    try {
      // 1. Idempotency Check (Prevent duplicates)
      if (reference) {
        const existingLog = await this.prisma.webhookLog.findFirst({
          where: {
            resourceId: reference,
            status: 'PROCESSED',
            id: { not: logId },
          },
        });

        if (existingLog) {
          this.logger.log(`Skipping duplicate event for ref: ${reference}`);
          return;
        }
      }

      // 2. Event Handling Switch
      switch (event) {
        case 'charge.success':
          // RENEWAL or NEW SIGNUP: This is the most important one.
          // It extends the currentPeriodEnd in the DB.
          await this.billingService.activateSubscription(payload);
          break;

        case 'subscription.create':
          // SYNC: Saves the email_token and subscription_code
          await this.billingService.saveSubscriptionDetails(payload);
          break;

        case 'invoice.payment_failed':
        case 'subscription.not_renew': // Optional: Paystack event for stopped renewals
        case 'subscription.disable':
          // EXPIRATION: Determine which code to use
          // Note: 'subscription.disable' sends code in data.code, others might be data.subscription_code
          const subCode = data.subscription_code || data.code;

          if (subCode) {
            await this.billingService.markAsExpired(subCode);
            this.logger.warn(`Subscription marked past_due: ${subCode}`);
          }
          break;

        default:
          this.logger.log(`Unhandled Paystack event: ${event}`);
      }

      // Mark Log as Processed
      await this.prisma.webhookLog.update({
        where: { id: logId },
        data: { status: 'PROCESSED', organizationId, processedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `Paystack Processing Error [LogID: ${logId}]: ${error.message}`,
      );
      throw error; // Rethrow to be caught by outer handler
    }
  }

  // ==========================================
  // TIKTOK LOGIC
  // ==========================================

  private async processTikTokPublish(logId: string, payload: any) {
    const event = payload.event;

    // 🚨 TikTok sends the content field as a stringified JSON string. We must parse it!
    let content: any = {};
    if (typeof payload.content === 'string') {
      try {
        content = JSON.parse(payload.content);
      } catch (e) {
        this.logger.error(
          `Failed to parse TikTok webhook content: ${payload.content}`,
        );
      }
    } else {
      content = payload.content || {};
    }

    const publishId = content.publish_id;

    if (!publishId) {
      this.logger.warn(
        `TikTok publish webhook missing publish_id: Log ${logId}`,
      );
      return;
    }

    // 1. Find the pending destination in the DB
    const destination = await this.prisma.postDestination.findFirst({
      where: { platformPostId: publishId },
      include: {
        post: true,
        profile: {
          include: {
            connection: true,
          },
        },
      },
    });

    if (destination) {
      // 2. Update the status based on the TikTok event
      if (
        event === 'post.publish.complete' ||
        event === 'video.publish.completed'
      ) {
        let liveUrl = 'https://www.tiktok.com/@tiktok'; // Default fallback

        // 🚨 FIX: Fetch the actual public URL from TikTok's API
        try {
          const accessToken = await this.encryptionService.decrypt(
            destination.profile.accessToken,
          );

          const statusResponse = await axios.post(
            'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
            { publish_id: publishId },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              transformResponse: [
                (data) => {
                  if (!data) return data;
                  try {
                    return JSONBig.parse(data);
                  } catch (e) {
                    return data;
                  }
                },
              ],
            },
          );

          const publicIds =
            statusResponse.data?.data?.publicaly_available_post_id || [];

          if (publicIds.length > 0) {
            const publicId = publicIds[0];

            // 🚨 FIX: Grab the username from your SocialProfile model!
            // We remove the "@" just in case you saved it as "@username" in the DB
            let rawUsername =
              destination.profile.username ||
              destination.profile.connection.platformUsername ||
              'tiktok';
            const cleanUsername = rawUsername.replace('@', '');

            liveUrl = `https://www.tiktok.com/@${cleanUsername}/video/${publicId}`;
          }
        } catch (error: any) {
          this.logger.error(
            `Failed to fetch live URL for TikTok post: ${error.message}`,
          );
        }

        await this.prisma.postDestination.update({
          where: { id: destination.id },
          data: {
            status: 'SUCCESS',
            platformUrl: liveUrl,
          },
        });

        // Bonus: Update the master post status to PUBLISHED if this was the only/last destination
        await this.prisma.post.update({
          where: { id: destination.postId },
          data: { status: 'PUBLISHED' },
        });

        this.logger.log(`TikTok video ${publishId} is live at ${liveUrl}!`);
      } else if (
        event === 'post.publish.failed' ||
        event === 'video.upload.failed'
      ) {
        await this.prisma.postDestination.update({
          where: { id: destination.id },
          data: {
            status: 'FAILED',
            errorMessage:
              'TikTok rejected the video during final processing (Community Guidelines/Copyright).',
          },
        });
        this.logger.warn(`TikTok video ${publishId} failed final processing.`);
      }
    } else {
      this.logger.warn(
        `Could not find PostDestination for TikTok publish_id: ${publishId}`,
      );
    }

    // 3. Mark Webhook Log as Processed
    await this.prisma.webhookLog.update({
      where: { id: logId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }

  private async processTikTokDeauth(logId: string, payload: any) {
    const openId = payload.user_openid;

    if (!openId) {
      this.logger.warn(
        `TikTok deauth webhook missing user_openid: Log ${logId}`,
      );
      return;
    }

    this.logger.log(`User ${openId} revoked TikTok access. Disconnecting...`);

    // 1. Find the Social Connection using the platformUserId (openId)
    const connection = await this.prisma.socialConnection.findFirst({
      where: { platformUserId: openId, platform: 'TIKTOK' },
    });

    if (connection) {
      // 2. Soft-delete/Disconnect the connection & cascade to profiles
      await this.prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          status: 'DISCONNECTED',
          profiles: {
            updateMany: {
              where: { socialConnectionId: connection.id },
              data: { status: 'DISCONNECTED' },
            },
          },
        },
      });
      this.logger.log(
        `Successfully disconnected TikTok connection ${connection.id}.`,
      );
    } else {
      this.logger.warn(
        `Could not find TikTok connection for user_openid: ${openId}`,
      );
    }

    // 3. Mark Webhook Log as Processed
    await this.prisma.webhookLog.update({
      where: { id: logId },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }
}
