import { BillingService } from '@/billing/billing.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('webhooks')
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(private readonly prisma: PrismaService, private readonly billingService: BillingService) {
    super();
  }

  async process(job: Job<{ logId: string; data: any }>) {
    const { logId, data } = job.data;

    try {
      if (job.name === 'paystack-event') {
        await this.processPaystack(logId, data);
      } else if (job.name === 'meta-event') {
        await this.processMeta(logId, data);
      }
    } catch (error) {
      this.logger.error(`Webhook Processing Failed [LogID: ${logId}]: ${error.message}`);
      
      // Mark as Failed in DB so we can debug later
      await this.prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        }
      });
      
      throw error; // Throwing ensures BullMQ will retry (if configured)
    }
  }

  // ==========================================
  // PAYSTACK LOGIC
  // ==========================================
  private async processPaystack(logId: string, payload: any) {
    const event = payload.event;
    let organizationId = payload.data?.metadata?.organizationId;

    try {
      if (event === 'charge.success') {
        await this.billingService.activateSubscription(payload);
      } 
      else if (event === 'subscription.create') {
        // This event runs in parallel to charge.success to save the email_token
        await this.billingService.saveSubscriptionDetails(payload);
      }else if (event === 'invoice.payment_failed') {
         // Logic to email user: "Your renewal failed"
         this.logger.warn(`Renewal failed for ${payload.data.customer.email}`);
      }

      // Mark Log as Processed
      await this.prisma.webhookLog.update({
        where: { id: logId },
        data: { status: 'PROCESSED', organizationId, processedAt: new Date() }
      });
    } catch (error) {
      this.logger.error(`Paystack Processing Error [LogID: ${logId}]: ${error.message}`);
      throw error; // Rethrow to be caught by outer handler
    }
  }

  // ==========================================
  // META LOGIC
  // ==========================================
  private async processMeta(logId: string, payload: any) {
    // Meta structure: entry -> [{ uid: '...', changes: [...] }]
    const entry = payload.entry?.[0];
    const uid = entry?.uid || entry?.id; // User ID or Page ID
    let organizationId: string | null = null;

    if (uid) {
      // 1. Find the Social Account to link back to Organization
      const socialAccount = await this.prisma.socialAccount.findFirst({
        where: { platformAccountId: uid, platform: 'META' },
        include: { organization: true },
      });

      if (socialAccount) {
        organizationId = socialAccount.organizationId;

        // 2. Check for De-authorization (Permissions Revoked)
        // If the payload indicates a revoke, we disable the account
        // (Simplified check - usually you look deeper into 'changes')
        if (payload.object === 'permissions') { 
             await this.prisma.socialAccount.update({
                where: { id: socialAccount.id },
                data: { isActive: false, errorMessage: 'User revoked permissions' }
             });
             this.logger.warn(`Disabled Meta account ${socialAccount.id} due to revoke`);
        }
      }
    }

    // 3. Finalize Log
    await this.prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'PROCESSED',
        organizationId: organizationId, // <--- LINKING HAPPENS HERE
        resourceId: uid, // Update resource ID if we found a better one
        processedAt: new Date(),
      }
    });
  }
}