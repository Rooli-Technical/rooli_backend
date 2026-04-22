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
          const purpose = data.metadata?.purpose;

          if (purpose === 'update_card') {
            // 🛡️ THE USER IS JUST SWAPPING CARDS
            const newAuthCode = data.authorization?.authorization_code;

            await this.prisma.$transaction([
              // 1. Save the new card token
              this.prisma.subscription.update({
                where: { organizationId },
                data: {
                  paystackAuthCode: newAuthCode,
                  status: 'ACTIVE', // Instantly cure any PAST_DUE dunning state!
                  lastPaymentFailedAt: null,
                  failedPaymentAttempts: 0,
                },
              }),
              this.prisma.organization.update({
                where: { id: organizationId },
                data: { billingStatus: 'ACTIVE' },
              }),
              // 2. Mark the 50 NGN auth transaction as successful
              this.prisma.transaction.updateMany({
                where: { txRef: reference, status: 'pending' },
                data: {
                  status: 'successful',
                  providerTxId: data.id.toString(),
                },
              }),
            ]);

            this.logger.log(
              `Card successfully replaced for Org: ${organizationId}`,
            );
          } else {
            // 💰 IT'S A NORMAL SUBSCRIPTION RENEWAL OR SIGNUP
            await this.billingService.activateSubscription(payload);
          }
          break;

        case 'subscription.create':
          // SYNC: Saves the email_token and subscription_code
          await this.billingService.saveSubscriptionDetails(payload);
          break;

        // 🚨 THE DUNNING TRIGGERS (Day 0)
        case 'charge.failed':
        case 'invoice.payment_failed':
          const type = data.metadata?.type;
          const failurePurpose = data.metadata?.purpose; // Catch the 'update_card' intent

          if (type === 'add_on_workspace') {
            // 1. ONE-OFF WORKSPACE PURCHASE FAILED
            // Just mark the transaction as failed. Do not touch the subscription status.
            await this.prisma.transaction.updateMany({
              where: { txRef: data.reference, status: 'pending' },
              data: { status: 'failed' },
            });
            this.logger.warn(
              `Workspace add-on charge failed for Ref: ${data.reference}`,
            );
          } else if (failurePurpose === 'update_card') {
            // 2. 🛡️ CARD UPDATE AUTHORIZATION FAILED
            // The user typed a bad card. Mark the 50 NGN auth transaction as failed.
            // DO NOT suspend their account, they might still have an active base plan!
            await this.prisma.transaction.updateMany({
              where: { txRef: data.reference, status: 'pending' },
              data: { status: 'failed' },
            });
            this.logger.warn(
              `Card replacement authorization failed for Ref: ${data.reference}`,
            );
          } else if (type === 'recurring_addons_and_overages') {
            // 3. (Optional) RECURRING ADD-ONS CRON FAILED
            // If you pass this metadata in your cron job, you can choose to handle it here.
            // Standard practice: Treat this like a base invoice failure and trigger dunning.
            await this.billingService.handleFailedPayment(data);
          } else {
            // 4. BASE SUBSCRIPTION RENEWAL FAILED
            // It's a genuine renewal failure. Trigger the dunning process!
            await this.billingService.handleFailedPayment(data);
          }
          break;

        // 🚨 THE CANCELLATION TRIGGERS
        case 'subscription.disable':
        case 'subscription.not_renew':
          // The user (or Paystack) has officially canceled the subscription.
          const subCode = data.subscription_code || data.code;
          if (subCode) {
            // ✅ FIX: Set PENDING_CANCELLATION, not CANCELED.
            // The actual CANCELED state is applied by the processPendingCancellations
            // cron when currentPeriodEnd passes. Setting CANCELED here would strip
            // access before the billing period ends.
            await this.prisma.subscription.updateMany({
              where: { paystackSubscriptionCode: subCode },
              data: {
                cancelAtPeriodEnd: true,
              },
            });
            await this.prisma.organization.updateMany({
              where: {
                subscription: { paystackSubscriptionCode: subCode },
              },
              data: { billingStatus: 'PENDING_CANCELLATION' },
            });
            this.logger.warn(`Subscription marked for cancellation at period end: ${subCode}`);
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
    let content: any = {};

    // 1. Parse stringified JSON if necessary
    try {
      content =
        typeof payload.content === 'string'
          ? JSON.parse(payload.content)
          : payload.content || {};
    } catch (e) {
      this.logger.error(
        `Failed to parse TikTok webhook content: ${payload.content}`,
      );
      content = {};
    }

    const publishId = content.publish_id;
    if (!publishId) {
      this.logger.warn(
        `TikTok publish webhook missing publish_id: Log ${logId}`,
      );
      return;
    }

    // 2. Find the destination
    const destination = await this.prisma.postDestination.findFirst({
      where: { platformPostId: publishId },
      include: {
        post: true,
        profile: { include: { connection: true } },
      },
    });

    if (!destination) {
      this.logger.warn(
        `Could not find PostDestination for TikTok publish_id: ${publishId}`,
      );
      return;
    }

    // 3. Handle Success Event
    if (
      event === 'post.publish.complete' ||
      event === 'video.publish.completed'
    ) {
      let finalVideoId = publishId; // Default to publish_id if fetch fails
      let liveUrl = null;

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
                try {
                  return JSONBig.parse(data);
                } catch {
                  return data;
                }
              },
            ],
          },
        );

        // TikTok typo: "publicaly"
        const publicIds =
          statusResponse.data?.data?.publicaly_available_post_id || [];

        if (publicIds.length > 0) {
          finalVideoId = publicIds[0].toString(); // This is our real numeric ID

          const rawUsername =
            destination.profile.username ||
            destination.profile.connection?.platformUsername ||
            'tiktok';
          const cleanUsername = rawUsername.replace('@', '');
          liveUrl = `https://www.tiktok.com/@${cleanUsername}/video/${finalVideoId}`;
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to fetch live URL for TikTok: ${error.message}`,
        );
      }

      // Update Destination (Swap publish_id for real video_id here)
      await this.prisma.postDestination.update({
        where: { id: destination.id },
        data: {
          status: 'SUCCESS',
          platformUrl: liveUrl,
          platformPostId: finalVideoId,
          publishedAt: new Date(),
        },
      });

      // Update Parent Post
      await this.prisma.post.update({
        where: { id: destination.postId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });

      this.logger.log(`TikTok post ${finalVideoId} is now SUCCESS.`);
    }

    // 4. Handle Failure Event
    else if (
      event === 'post.publish.failed' ||
      event === 'video.upload.failed'
    ) {
      await this.prisma.postDestination.update({
        where: { id: destination.id },
        data: {
          status: 'FAILED',
          errorMessage:
            'TikTok rejected the video during final processing (Guidelines/Copyright).',
        },
      });

      // Only mark parent as FAILED if you want to (Careful if multi-platform)
      await this.prisma.post.update({
        where: { id: destination.postId },
        data: { status: 'FAILED' },
      });
    }

    // 5. Cleanup Log
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
