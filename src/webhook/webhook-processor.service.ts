import { BillingService } from '@/billing/billing.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('webhooks')
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
  ) {
    super();
  }

  async process(job: Job<{ logId: string; data: any }>) {
    const { logId, data } = job.data;

    try {
      if (job.name === 'paystack-event') {
        await this.processPaystack(logId, data);
      } else if (job.name === 'meta-event') {
        //await this.processMeta(logId, data);
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
  // META LOGIC
  // ==========================================
  // private async processMeta(logId: string, payload: any) {
  //   // Meta structure: entry -> [{ uid: '...', changes: [...] }]
  //   const entry = payload.entry?.[0];
  //   const uid = entry?.uid || entry?.id; // User ID or Page ID
  //   let organizationId: string | null = null;

  //   if (uid) {
  //     // 1. Find the Social Account to link back to Organization
  //     const socialAccount = await this.prisma.socialAccount.findFirst({
  //       where: { platformAccountId: uid, platform: 'META' },
  //       include: { organization: true },
  //     });

  //     if (socialAccount) {
  //       organizationId = socialAccount.organizationId;

  //       // 2. Check for De-authorization (Permissions Revoked)
  //       // If the payload indicates a revoke, we disable the account
  //       // (Simplified check - usually you look deeper into 'changes')
  //       if (payload.object === 'permissions') {
  //         await this.prisma.socialAccount.update({
  //           where: { id: socialAccount.id },
  //           data: { isActive: false, errorMessage: 'User revoked permissions' },
  //         });
  //         this.logger.warn(
  //           `Disabled Meta account ${socialAccount.id} due to revoke`,
  //         );
  //       }
  //     }
  //   }

  //   // 3. Finalize Log
  //   await this.prisma.webhookLog.update({
  //     where: { id: logId },
  //     data: {
  //       status: 'PROCESSED',
  //       organizationId: organizationId, // <--- LINKING HAPPENS HERE
  //       resourceId: uid, // Update resource ID if we found a better one
  //       processedAt: new Date(),
  //     },
  //   });
  // }
}
