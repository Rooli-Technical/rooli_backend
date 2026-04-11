import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as geoip from 'geoip-lite';
import { MailService } from '@/mail/mail.service';
import { randomUUID } from 'crypto';
import { BillingInterval } from '@generated/enums';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@generated/client';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly PAYSTACK_BASE_URL = 'https://api.paystack.co';

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly emailService: MailService,
  ) {}

  // ---------------------------------------------------------
  // 1. GET AVAILABLE PLANS
  // ---------------------------------------------------------
  async getAvailablePlans(userIp: string, timeZone?: string) {
    const geo = geoip.lookup(userIp);
    const country = this.inferCountry(geo?.country, timeZone);
    const isNigeria = country === 'NG';

    const plans = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { monthlyPriceUsd: 'asc' }, // Order by tier level
    });

    return plans.map((plan) => {
      // Because your DB stores Kobo/Cents, we divide by 100 for the UI to display cleanly.
      const monthlyPrice = isNigeria
        ? plan.monthlyPriceNgn / 100
        : plan.monthlyPriceUsd / 100;
      const annualPrice = isNigeria
        ? plan.annualPriceNgn / 100
        : plan.annualPriceUsd / 100;

      return {
        id: plan.id,
        name: plan.name,
        badge: plan.badge,
        tier: plan.tier,
        description: plan.description,
        features: this.formatFeatures(plan.features),

        limits: {
          workspaces: plan.maxWorkspaces,
          socialProfiles: plan.maxSocialProfiles,
          users: plan.maxUsers,
          aiCredits: plan.aiCreditsMonthly,
        },

        pricing: {
          currency: isNigeria ? 'NGN' : 'USD',
          monthly: monthlyPrice,
          annual: annualPrice,
        },
      };
    });
  }

  async getSubscription(organizationId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) return null;

    return {
      ...subscription,
      isActive:
        subscription.status === 'ACTIVE' &&
        new Date() < subscription.currentPeriodEnd,
    };
  }

  // ---------------------------------------------------------
  // 3. INITIALIZE PAYMENT (Dynamic NGN & USD Support)
  // ---------------------------------------------------------
  async initializePayment(
    organizationId: string,
    planId: string,
    interval: 'MONTHLY' | 'ANNUAL',
    user: any,
  ) {
    const finalUserId = user.id || user.userId;
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { members: true }
    });
    const email = org.billingEmail || user?.email;
    if (!email) throw new BadRequestException('Billing email is required');

   const isMember = org.members.some((member) => member.userId === finalUserId);
    if (!isMember) {
      throw new ForbiddenException('Invalid organization context');
    }

    // 1. Determine Currency from the Organization (Defaults to NGN in your schema)
    const targetCurrency = org.currency || 'NGN';

    // 2. Select the correct Code and Amount based on INTERVAL and CURRENCY
    let amountInBaseUnit: number; // Kobo for NGN, Cents for USD
    let paystackPlanCode: string;

    if (targetCurrency === 'USD') {
      if (interval === 'ANNUAL') {
        amountInBaseUnit = plan.annualPriceUsd;
        paystackPlanCode = plan.paystackPlanCodeAnnualUsd;
      } else {
        amountInBaseUnit = plan.monthlyPriceUsd;
        paystackPlanCode = plan.paystackPlanCodeMonthlyUsd;
      }
    } else {
      // Fallback to NGN
      if (interval === 'ANNUAL') {
        amountInBaseUnit = plan.annualPriceNgn;
        paystackPlanCode = plan.paystackPlanCodeAnnualNgn;
      } else {
        amountInBaseUnit = plan.monthlyPriceNgn;
        paystackPlanCode = plan.paystackPlanCodeMonthlyNgn;
      }
    }

    // Safety check: ensure you've added the Paystack code to the DB for this currency/interval!
    if (!paystackPlanCode || paystackPlanCode === 'MANUAL') {
      throw new BadRequestException(
        `This plan is not configured for ${interval} ${targetCurrency} payments yet.`,
      );
    }

    // Clean up orphaned transactions
    await this.prisma.transaction.updateMany({
      where: { organizationId: org.id, status: 'pending' },
      data: { status: 'abandoned' },
    });

    // Pass the selected data to the Paystack helper
    return this.initializePaystack(
      org,
      plan,
      email,
      amountInBaseUnit,
      paystackPlanCode,
      targetCurrency,
    );
  }

  // ---------------------------------------------------------
  // 4. ACTIVATE SUBSCRIPTION (Webhook Handler)
  // ---------------------------------------------------------
  async activateSubscription(payload: any) {
    const data = payload.data;
    const { reference, amount, currency, metadata, plan, authorization, id } =
      data;

    // 1. Identify Organization
    const organizationId = metadata?.organizationId;
    if (!organizationId) {
      this.logger.error(`Paystack charge missing organizationId: ${reference}`);
      return;
    }

    // 2. Identify Plan using the Paystack Code
    const paystackPlanCode = plan?.plan_code;
    if (!paystackPlanCode) {
      this.logger.error(`Charge ${reference} has no plan code`);
      return;
    }

    //  MULTI-CURRENCY & MULTI-INTERVAL LOOKUP
    // We search the DB to see if this code matches ANY of the 4 columns
    const localPlan = await this.prisma.plan.findFirst({
      where: {
        OR: [
          { paystackPlanCodeMonthlyNgn: paystackPlanCode },
          { paystackPlanCodeAnnualNgn: paystackPlanCode },
          { paystackPlanCodeMonthlyUsd: paystackPlanCode },
          { paystackPlanCodeAnnualUsd: paystackPlanCode },
        ],
      },
    });

    if (!localPlan) {
      this.logger.error(`Unknown Paystack Plan Code: ${paystackPlanCode}`);
      return;
    }

    // 3. Determine Interval & Calculate Dates
    // If the code matches either of the Annual columns, it's an Annual sub!
    const isAnnual =
      localPlan.paystackPlanCodeAnnualNgn === paystackPlanCode ||
      localPlan.paystackPlanCodeAnnualUsd === paystackPlanCode;

    const billingInterval = isAnnual ? 'ANNUAL' : 'MONTHLY';

    const startDate = new Date();
    const endDate = new Date();
    if (billingInterval === 'ANNUAL') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    // 4. DB Transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const previousSuccessCount = await tx.transaction.count({
        where: { organizationId, status: 'successful' },
      });
      const isNewSignup = previousSuccessCount === 0;

      //  UPDATE SUBSCRIPTION & CLEAR DUNNING ANCHORS
      await tx.subscription.upsert({
        where: { organizationId },
        create: {
          organizationId,
          planId: localPlan.id,
          status: 'ACTIVE',
          isActive: true,
          billingInterval: billingInterval as BillingInterval,
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          paystackAuthCode: authorization?.authorization_code,
          isTrial: false,
          watermarkEnabled: false,
          lastPaymentFailedAt: null,
          failedPaymentAttempts: 0,
          aiCreditsUsed: 0,
          lastCreditResetAt: new Date(),
        },
        update: {
          planId: localPlan.id,
          status: 'ACTIVE',
          isActive: true,
          billingInterval: billingInterval as BillingInterval,
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          paystackAuthCode: authorization?.authorization_code,
          cancelAtPeriodEnd: false,
          isTrial: false,
          watermarkEnabled: false,
          lastPaymentFailedAt: null,
          failedPaymentAttempts: 0,
        },
      });

      // Update Transaction Log
      await tx.transaction.upsert({
        where: { txRef: reference },
        update: {
          providerTxId: id.toString(),
          status: 'successful',
          paymentDate: new Date(),
        },
        create: {
          organizationId,
          txRef: reference,
          providerTxId: id.toString(),
          provider: 'PAYSTACK',
          amount: Number(amount) / 100, // Convert Paystack's Kobo/Cents back to whole Naira/Dollars
          currency: currency || 'NGN',
          status: 'successful',
          paymentDate: new Date(),
        },
      });

      //  UNLOCK THE ORGANIZATION
      const org = await tx.organization.update({
        where: { id: organizationId },
        data: {
          status: 'ACTIVE',
          billingStatus: 'ACTIVE',
          isActive: true,
          readOnly: false, // Clear Day 8 Dunning read-only state!
        },
        include: {
          members: {
            where: { role: { slug: 'org-owner' } },
            include: { user: true },
            take: 1,
          },
          workspaces: {
            take: 1,
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      // Unlock social profiles (In case they hit Day 14 Suspension)
      await tx.socialProfile.updateMany({
        where: {
          workspace: { organizationId: organizationId },
        },
        data: { isActive: true },
      });

      return { org, isNewSignup };
    });

    // 5. Send Welcome Email Logic
    if (result.isNewSignup) {
      const owner = result.org.members[0]?.user;
      const defaultWorkspace = result.org.workspaces[0];

      if (owner && defaultWorkspace) {
        this.emailService
          .sendWelcomeEmail(owner.email, owner.firstName, defaultWorkspace.name)
          .catch((e) => this.logger.error(`Failed to send welcome email`, e));
      }
    } else {
      this.logger.log(
        `Renewal payment processed for Org: ${organizationId}. Account Unlocked.`,
      );
    }

    return result;
  }
  // ---------------------------------------------------------
  // 5. SYNC SUBSCRIPTION DETAILS (Webhook)
  // ---------------------------------------------------------
  async saveSubscriptionDetails(payload: any) {
    const data = payload.data;
    const { subscription_code, email_token, customer } = data;

    const org = await this.prisma.organization.findFirst({
      where: { billingEmail: customer.email },
    });

    if (!org) return;

    await this.prisma.subscription.update({
      where: { organizationId: org.id },
      data: {
        paystackSubscriptionCode: subscription_code,
        paystackEmailToken: email_token,
      },
    });
  }

  // ---------------------------------------------------------
  // 6. CANCEL SUBSCRIPTION
  // ---------------------------------------------------------
  async cancelSubscription(organizationId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });

    if (!sub?.paystackSubscriptionCode || !sub?.paystackEmailToken) {
      throw new BadRequestException('Missing subscription credentials');
    }

    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.PAYSTACK_BASE_URL}/subscription/disable`,
          {
            code: sub.paystackSubscriptionCode,
            token: sub.paystackEmailToken,
          },
          {
            headers: {
              Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
            },
          },
        ),
      );

      return await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { organizationId },
          data: {
            cancelAtPeriodEnd: true,
          },
        }),
        this.prisma.organization.update({
          where: { id: organizationId },
          data: { billingStatus: 'CANCELED' },
        }),
      ]);
    } catch (e) {
      this.logger.error(e.response?.data);
      throw new BadRequestException('Cancellation failed');
    }
  }

  // ---------------------------------------------------------
  // CHANGE PLAN (Instant for Trials, Scheduled for Paid)
  // ---------------------------------------------------------
  async changePlan(
    organizationId: string,
    newPlanId: string,
    interval: 'MONTHLY' | 'ANNUAL',
    user: any,
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true } },
        members: true,
      },
    });

    if (!org || !org.subscription)
      throw new BadRequestException('No subscription found');

    const sub = org.subscription;
    const newPlan = await this.prisma.plan.findUnique({
      where: { id: newPlanId },
    });
    if (!newPlan) throw new NotFoundException('Target plan not found');

    // 1. FREE TRIAL OVERRIDE -> INSTANT CHECKOUT
    // If they are on a trial, they skip scheduling and go straight to checkout
    if (sub.isTrial) {
      return this.initializePayment(org.id, newPlan.id, interval, user);
    }

    // 2. PAID TO PAID -> PRE-FLIGHT LIMIT CHECKS
    // Before we let them schedule a downgrade, we must verify they fit the new plan
    const [userCount, profileCount, workspaceCount] = await Promise.all([
      this.prisma.organizationMember.count({ where: { organizationId } }),
      this.prisma.socialProfile.count({
        where: { workspace: { organizationId }, status: 'CONNECTED' },
      }),
      this.prisma.workspace.count({ where: { organizationId } }),
    ]);

    // Check Users limits (ignoring Unlimited/9999)
    if (newPlan.maxUsers < 9999 && userCount > newPlan.maxUsers) {
      throw new BadRequestException(
        `Please remove ${userCount - newPlan.maxUsers} team members before switching to the ${newPlan.name} plan.`,
      );
    }

    // Check Social Profiles limits
    if (
      newPlan.maxSocialProfiles < 9999 &&
      profileCount > newPlan.maxSocialProfiles
    ) {
      throw new BadRequestException(
        `Please disconnect ${profileCount - newPlan.maxSocialProfiles} social profiles before switching to the ${newPlan.name} plan.`,
      );
    }

    // Check Workspaces limits
    if (
      newPlan.maxWorkspaces < 9999 &&
      workspaceCount > newPlan.maxWorkspaces
    ) {
      throw new BadRequestException(
        `Please delete ${workspaceCount - newPlan.maxWorkspaces} workspaces before switching to the ${newPlan.name} plan.`,
      );
    }

    // 3. SCHEDULE THE CHANGE
    await this.prisma.subscription.update({
      where: { organizationId },
      data: {
        pendingPlanId: newPlan.id,
        // Add pendingBillingInterval to your Prisma schema!
        pendingBillingInterval: interval as BillingInterval,
      },
    });

    return {
      status: 'scheduled',
      message: `Your plan will automatically change to ${newPlan.name} (${interval}) at the end of your current billing cycle.`,
    };
  }

  // ---------------------------------------------------------
  // 7. HANDLE FAILURES (Sets the Dunning Anchor)
  // ---------------------------------------------------------
  async handleFailedPayment(paystackData: any) {
    const { reference, amount, currency, metadata, gateway_response, id } =
      paystackData;
    const organizationId = metadata?.organizationId;
    if (!organizationId) return;

    await this.prisma.transaction.create({
      data: {
        organizationId,
        txRef: reference,
        providerTxId: id.toString(),
        provider: 'PAYSTACK',
        amount: Number(amount) / 100,
        currency: currency || 'NGN',
        status: 'failed',
        paymentDate: new Date(),
      },
    });

    // 🚨 SET DUNNING ANCHOR
    await this.prisma.subscription.updateMany({
      where: { organizationId },
      data: {
        status: 'PAST_DUE',
        lastPaymentFailedAt: new Date(),
        failedPaymentAttempts: { increment: 1 },
      },
    });

    // NEW: Send Day 0 Email
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { members: { include: { user: true, role: true } } },
    });

    if (org) {
      const owner = org.members.find((m) => m.role.slug === 'org-owner')?.user;
      if (owner) {
        await this.emailService.sendPaymentFailedEmail(owner.email, org.name);
      }
    }
    this.logger.warn(`Payment failed: ${gateway_response}. Dunning started.`);
  }

  private formatFeatures(features: any): string[] {
    if (!features || typeof features !== 'object') return [];

    const formattedList: string[] = [];

    // 1. Handle special string-based features (like analytics)
    if (features.analytics) {
      formattedList.push(
        features.analytics === 'basic' ? 'Basic Analytics' : 'Advanced Analytics'
      );
    }

    // 2. Map your boolean features to human-readable labels
    const booleanFeatureMap: Record<string, string> = {
      bulkScheduling: 'Bulk Scheduling',
      postApprovals: 'Post Approvals',
      repurposeContent: 'Content Repurposing',
      bulkAI: 'Bulk AI Generation',
      whiteLabelReports: 'White-label Analytics Reports',
      clientPortal: 'Dedicated Client Portal',
      prioritySupport: 'Priority Customer Support',
      campaignPlanning: 'Advanced Campaign Planning',
      sla: 'Custom SLA Guarantee',
    };

    // Loop through the map and add the label if the feature is true
    for (const [key, label] of Object.entries(booleanFeatureMap)) {
      if (features[key] === true) {
        formattedList.push(label);
      }
    }

    return formattedList;
  }

  // ---------------------------------------------------------
  // 8. THE DUNNING CRON JOB
  // ---------------------------------------------------------
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async executeDunningAndTrials() {
    this.logger.log('🕵️ Executing Dunning & Trial State Machine...');
    const now = new Date();

    // FIX 1: Calculate the exact timestamps for the queries
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(now.getDate() - 8);

    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(now.getDate() - 14);

    // -----------------------------------------------------------------
    // PHASE 1: Expire Free Trials
    // -----------------------------------------------------------------
    const expiredTrials = await this.prisma.subscription.updateMany({
      where: { isTrial: true, status: 'TRIALING', trialEndsAt: { lt: now } },
      data: { status: 'PAST_DUE', isActive: false },
    });

    if (expiredTrials.count > 0) {
      await this.prisma.organization.updateMany({
        where: { subscription: { isTrial: true, status: 'PAST_DUE' } },
        data: { readOnly: true },
      });
    }

    // -----------------------------------------------------------------
    // PHASE 2: Day 8 Read-Only Enforcements
    // -----------------------------------------------------------------
    const eightDayOrgs = await this.prisma.organization.findMany({
      where: {
        readOnly: false,
        subscription: {
          status: 'PAST_DUE',
          lastPaymentFailedAt: { lte: eightDaysAgo },
          readOnlyNotifiedAt: null,
        },
      },
      select: { id: true, billingEmail: true },
    });

    if (eightDayOrgs.length > 0) {
      const orgIds = eightDayOrgs.map((o) => o.id);

      await this.prisma.organization.updateMany({
        where: { id: { in: orgIds } },
        data: { readOnly: true, billingStatus: 'READ_ONLY' },
      });

      await this.prisma.subscription.updateMany({
        where: { organizationId: { in: orgIds } },
        data: { readOnlyNotifiedAt: new Date() },
      });

      Promise.allSettled(
        eightDayOrgs.map((org) =>
          this.emailService.sendReadOnlyWarningEmail(org.billingEmail),
        ),
      );
    }

    // -----------------------------------------------------------------
    // PHASE 3: Day 14 Hard Suspensions
    // -----------------------------------------------------------------
    const doomedSubs = await this.prisma.subscription.findMany({
      where: {
        status: 'PAST_DUE',
        lastPaymentFailedAt: { lte: fourteenDaysAgo },
        suspendedNotifiedAt: null,
      },
      include: {
        organization: { select: { id: true, billingEmail: true } },
      },
    });

    if (doomedSubs.length > 0) {
      const orgIds = doomedSubs.map((s) => s.organizationId);

      await this.prisma.$transaction([
        this.prisma.subscription.updateMany({
          where: { organizationId: { in: orgIds } },
          data: {
            status: 'SUSPENDED',
            isActive: false,
            suspendedNotifiedAt: new Date(),
          },
        }),
        this.prisma.organization.updateMany({
          where: { id: { in: orgIds } },
          data: {
            status: 'SUSPENDED',
            isActive: false,
            billingStatus: 'SUSPENDED',
          },
        }),
        // 🚨 FIX 2: Deactivate Social Profiles to stop the publishing queue!
        this.prisma.socialProfile.updateMany({
          where: { workspace: { organizationId: { in: orgIds } } },
          data: { isActive: false },
        }),
      ]);

      Promise.allSettled(
        doomedSubs.map((s) =>
          this.emailService.sendAccountSuspendedEmail(
            s.organization.billingEmail,
          ),
        ),
      );
    }
  }

  async verifyPayment(reference: string) {
    // 1. FAST CHECK
    const existingTx = await this.prisma.transaction.findUnique({
      where: { txRef: reference },
    });
    if (existingTx && existingTx.status === 'successful') {
      return { status: 'success', message: 'Payment already verified' };
    }

    // 2. API CHECK
    const { data } = await firstValueFrom(
      this.httpService.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
          },
        },
      ),
    );

    const status = data.data.status;
    if (status === 'success') return { status: 'pending_webhook' };
    if (status === 'failed' || status === 'abandoned') {
      await this.handleFailedPayment(data.data);
      throw new BadRequestException('Payment failed or was declined');
    }
    return data.data;
  }

  // ---------------------------------------------------------
  // 2. START FREE TRIAL (Called by Onboarding)
  // ---------------------------------------------------------
  async startTrial(
    organizationId: string,
    planId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    // Edge case check (Improvement #3)
    const existing = await tx.subscription.findUnique({
      where: { organizationId },
    });
    if (existing)
      throw new BadRequestException('Organization already has a subscription');

    const now = new Date();
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    return tx.subscription.create({
      data: {
        organizationId,
        planId,
        status: 'TRIALING',
        isActive: true,
        billingInterval: 'MONTHLY',
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
        isTrial: true,
        trialStartAt: now,
        trialEndsAt: trialEndsAt,
        watermarkEnabled: true,
        aiCreditsUsed: 0,
        lastCreditResetAt: now,
      },
    });
  }
  // ---------------------------------------------------------
  // PRIVATE HELPER (Multi-Currency Initialization)
  // ---------------------------------------------------------
  private async initializePaystack(
    org: any,
    plan: any,
    email: string,
    amountInBaseUnit: number, // Kobo or Cents
    paystackPlanCode: string,
    currency: string, // 'NGN' or 'USD'
  ) {
    const reference = `rooli_${org.id}_${randomUUID()}`;

    // Safety check for free plans or zero price
    if (amountInBaseUnit <= 0) {
      throw new BadRequestException(
        'Cannot process zero value payment via gateway',
      );
    }

    // 1. Create Pending Transaction in the DB
    await this.prisma.transaction.create({
      data: {
        organizationId: org.id,
        txRef: reference,
        providerTxId: 'pending',
        provider: 'PAYSTACK',
        amount: amountInBaseUnit / 100, // Convert Kobo/Cents back to standard ₦ or $ for the DB log
        currency: currency, // 👈 Dynamically saved as NGN or USD
        status: 'pending',
        paymentDate: new Date(),
      },
    });

    // 2. Build the Paystack Payload
    const payload = {
      email,
      amount: amountInBaseUnit, // Already in Kobo/Cents from the DB!
      plan: paystackPlanCode,
      reference,
      currency: currency, // 👈 Tell Paystack to charge in NGN or USD
      metadata: {
        organizationId: org.id,
        targetPlanId: plan.id,
        gateway: 'PAYSTACK',
      },
      callback_url: `${this.config.get('CALLBACK_URL')}`,
    };

    // 3. Fire the Request
    try {
      const { data } = await firstValueFrom(
        this.httpService.post(
          `${this.PAYSTACK_BASE_URL}/transaction/initialize`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
            },
          },
        ),
      );
      return { paymentUrl: data.data.authorization_url, reference };
    } catch (error) {
      await this.prisma.transaction
        .update({ where: { txRef: reference }, data: { status: 'failed' } })
        .catch(() => {});
      this.logger.error('Paystack Init Error', error.response?.data);
      throw new BadRequestException('Paystack initialization failed');
    }
  }

  async markAsExpired(paystackCode: string) {
    await this.prisma.subscription.updateMany({
      where: { paystackSubscriptionCode: paystackCode },
      data: {
        status: 'PAST_DUE', // Blocks access immediately
        isActive: false,
      },
    });
  }

  //@Cron(CronExpression.EVERY_WEEKEND) // Runs once a week
  async cleanupStuckTransactions() {
    this.logger.log('🧹 Sweeping abandoned and stuck transactions...');

    // Look back 7 days. Anything older than this is definitely dead.
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const deleted = await this.prisma.transaction.deleteMany({
      where: {
        status: { in: ['abandoned', 'pending'] }, // Clear both abandoned and stuck pending
        createdAt: { lt: cutoffDate }, // Older than 7 days
      },
    });

    if (deleted.count > 0) {
      this.logger.log(
        `🗑️ Deleted ${deleted.count} dead checkout transactions.`,
      );
    }
  }

// ---------------------------------------------------------
  // RECURRING ADD-ONS & OVERAGES CRON
  // Runs daily to charge for overages and extra workspaces before renewal
  // ---------------------------------------------------------
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processRecurringAddonsAndOverages() {
    this.logger.log('🧹 Sweeping for Add-ons and AI Overages...');
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 1. Find subs renewing tomorrow that have overages OR extra workspaces
    const subsToCharge = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        currentPeriodEnd: { lte: tomorrow },
        OR: [
          { aiOverageCostCents: { gt: 0 } },
          { extraWorkspacesPurchased: { gt: 0 } }
        ]
      },
      include: {
        organization: { select: { id: true, billingEmail: true, currency: true } } 
      }
    });

    const FX_RATE = 1470; // ₦1,470/USD
    const WORKSPACE_ADDON_USD = 15;

    for (const sub of subsToCharge) {
      if (!sub.paystackAuthCode) continue; // Safety check

      const targetCurrency = sub.organization.currency || 'NGN';
      
      // Calculate Workspace Add-on Cost (Dual Currency)
      const workspaceAddonBaseUnit = targetCurrency === 'USD'
        ? sub.extraWorkspacesPurchased * WORKSPACE_ADDON_USD * 100
        : sub.extraWorkspacesPurchased * WORKSPACE_ADDON_USD * FX_RATE * 100;

      // Calculate Total Amount to charge (Add-on + AI Overages)
      const totalChargeBaseUnit = workspaceAddonBaseUnit + sub.aiOverageCostCents;

      try {
        const reference = `rooli_addon_${sub.organizationId}_${Date.now()}`;

        // 2. Hit Paystack API
        const { data: paystackResponse } = await firstValueFrom(
          this.httpService.post(
            'https://api.paystack.co/transaction/charge_authorization',
            {
              authorization_code: sub.paystackAuthCode,
              email: sub.organization.billingEmail, 
              amount: totalChargeBaseUnit, 
              currency: targetCurrency,
              reference: reference,
            },
            {
              headers: { Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}` },
            },
          ),
        );

        // 3. Create Transaction Record & Clear Overage Ledger
        await this.prisma.$transaction([
          this.prisma.transaction.create({
            data: {
              organizationId: sub.organizationId,
              txRef: reference,
              providerTxId: paystackResponse.data.id.toString(),
              provider: 'PAYSTACK',
              amount: totalChargeBaseUnit / 100, 
              currency: targetCurrency,
              status: 'successful',
              paymentDate: new Date(),
              subscriptionId: sub.id,
              metadata: { 
                type: 'recurring_addons_and_overages',
                workspacesPurchased: sub.extraWorkspacesPurchased,
                aiOverageCost: sub.aiOverageCostCents / 100
              }
            },
          }),
          // Reset the overage counter (but KEEP the extraWorkspacesPurchased intact!)
          this.prisma.subscription.update({
            where: { id: sub.id },
            data: { aiOverageCostCents: 0 } 
          })
        ]);
        
      } catch (error: any) {
        this.logger.error(`Failed to charge add-ons for Org ${sub.organizationId}`);
        // If this fails, you might want to trigger a warning email or pause the add-on features
      }
    }
  }

  // ---------------------------------------------------------
  // 9. PROCESS CANCELLATIONS AT PERIOD END
  // ---------------------------------------------------------
  @Cron(CronExpression.EVERY_HOUR)
  async processPendingCancellations() {
    this.logger.log(
      '🧹 Sweeping for subscriptions that have reached the end of their canceled period...',
    );
    const now = new Date();

    // 1. Find subscriptions marked to cancel where the period has officially ended
    const expiredCancellations = await this.prisma.subscription.findMany({
      where: {
        cancelAtPeriodEnd: true,
        isActive: true,
        currentPeriodEnd: { lte: now },
      },
      select: { id: true, organizationId: true },
    });

    if (expiredCancellations.length === 0) return;

    const orgIds = expiredCancellations.map((sub) => sub.organizationId);

    // 2. Execute the state transition via Transaction
    await this.prisma.$transaction([
      // A. Mark subscription as officially canceled
      this.prisma.subscription.updateMany({
        where: { id: { in: expiredCancellations.map((s) => s.id) } },
        data: {
          status: 'CANCELED',
          isActive: false,
        },
      }),

      // B. Update Organization billing status
      this.prisma.organization.updateMany({
        where: { id: { in: orgIds } },
        data: {
          status: 'SUSPENDED', // Or whatever your base state is for dead accounts
          billingStatus: 'CANCELED',
        },
      }),

      // C. Deactivate Social Profiles to immediately halt the publishing queue
      this.prisma.socialProfile.updateMany({
        where: { workspace: { organizationId: { in: orgIds } } },
        data: { isActive: false },
      }),
    ]);

    this.logger.log(
      `✅ Processed ${expiredCancellations.length} end-of-period cancellations. Publishing halted and accounts locked.`,
    );
  }

// ---------------------------------------------------------
  // PURCHASE EXTRA WORKSPACE (Rocket Only, Dual-Currency Prorated)
  // ---------------------------------------------------------
  async purchaseExtraWorkspace(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true } },
      },
    });

    if (!org || !org.subscription) {
      throw new BadRequestException('No active subscription found.');
    }

    const sub = org.subscription;

   // 1. SPEC GUARDRAIL: Business & Rocket Plans Only
    if (!['BUSINESS', 'ROCKET'].includes(sub.plan.tier)) {
      throw new ForbiddenException(
        'Purchasing additional workspaces is only available on the Business and Rocket plans.'
      );
    }

    // 2. CURRENCY & PRICING SETUP
    const targetCurrency = org.currency || 'NGN'; // Defaulting to your system's base
    const FX_RATE = 1470; // ₦1,470/USD as per spec
    const EXTRA_WORKSPACE_USD = 15; 

    // Convert to base units (Cents for USD, Kobo for NGN)
    const basePriceBaseUnit = targetCurrency === 'USD' 
      ? EXTRA_WORKSPACE_USD * 100 // 1500 Cents
      : EXTRA_WORKSPACE_USD * FX_RATE * 100; // 2205000 Kobo (₦22,050)

    // 3. PRORATION MATH
    const now = new Date();
    const periodEnd = new Date(sub.currentPeriodEnd);
    const periodStart = new Date(sub.currentPeriodStart);
    
    // Total days in their current billing cycle
    const totalDaysInCycle = Math.round((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
    
    // Days remaining
    const daysRemaining = Math.max(0, Math.round((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    
    // Prorated amount: (Days Remaining / Total Days) * Base Price
    const proratedAmountBaseUnit = Math.round((daysRemaining / totalDaysInCycle) * basePriceBaseUnit);

    // 4. CHARGE THE USER (One-Click)
    if (!sub.paystackAuthCode) {
      throw new BadRequestException('No payment method on file. Please update your billing details.');
    }

    try {
      const reference = `rooli_ws_${org.id}_${Date.now()}`;
      // Hit Paystack API to charge their saved card instantly
      // 1. Hit Paystack API and capture the response
      const { data: paystackResponse } = await firstValueFrom(
        this.httpService.post(
          'https://api.paystack.co/transaction/charge_authorization',
          {
            authorization_code: sub.paystackAuthCode,
            email: org.billingEmail,
            amount: proratedAmountBaseUnit, 
            currency: targetCurrency,       
            reference: reference, 
          },
          {
            headers: { Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}` },
          },
        ),
      );

      const paystackData = paystackResponse.data;

      // 2. Perform DB Updates in a single transaction
      await this.prisma.$transaction([
        // A. Increment the workspace allowance
        this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            extraWorkspacesPurchased: { increment: 1 },
          },
        }),
        
        // B. Create the Transaction Record
        this.prisma.transaction.create({
          data: {
            organizationId: org.id,
            txRef: reference,
            providerTxId: paystackData.id.toString(),
            provider: 'PAYSTACK',
            amount: proratedAmountBaseUnit / 100, // Convert back to standard ₦ or $
            currency: targetCurrency,
            status: 'successful',
            paymentDate: new Date(),
            subscriptionId: sub.id, // Link it for easy auditing
            metadata: { 
              type: 'add_on_workspace',
              proratedDays: daysRemaining 
            }
          },
        }),
      ]);

      return {
        message: `Additional workspace purchased successfully.`,
        amountCharged: proratedAmountBaseUnit / 100, // Converted back to ₦ or $ for the UI response
        currency: targetCurrency,
        newTotalWorkspacesAllowed: sub.plan.maxWorkspaces + sub.extraWorkspacesPurchased + 1
      };

    } catch (error: any) {
      this.logger.error('Failed to charge for extra workspace', error.response?.data || error.message);
      throw new BadRequestException('Payment failed. Could not add extra workspace.');
    }
  }

  // ---------------------------------------------------------
  // CANCEL EXTRA WORKSPACE ADD-ON
  // ---------------------------------------------------------
  async cancelExtraWorkspace(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { workspaces: true } }, // 👈 We need to know how many they are actually using!
      },
    });

    if (!org || !org.subscription) {
      throw new BadRequestException('No active subscription found.');
    }

    const sub = org.subscription;

    // 1. Ensure they actually have an add-on to cancel
    if (sub.extraWorkspacesPurchased <= 0) {
      throw new BadRequestException("You do not have any extra workspaces to cancel.");
    }

    // 2. Calculate what their limit will drop to
    const baseLimit = sub.plan.maxWorkspaces;
    const newTotalLimit = baseLimit + sub.extraWorkspacesPurchased - 1;

    // 3. THE USAGE GUARDRAIL
    // If they have 6 workspaces, they can't drop their limit to 5!
    if (org._count.workspaces > newTotalLimit) {
      throw new BadRequestException(
        `You currently have ${org._count.workspaces} active workspaces. Please delete at least 1 workspace before canceling this add-on.`
      );
    }

    // 4. Safely decrement the billing ledger
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        extraWorkspacesPurchased: { decrement: 1 },
      },
    });

    return {
      message: 'Workspace add-on successfully canceled. You will not be billed for it on your next cycle.',
      newTotalWorkspacesAllowed: newTotalLimit,
      extraWorkspacesRemaining: sub.extraWorkspacesPurchased - 1,
    };
  }

  private inferCountry(ipCountry?: string, timeZone?: string) {
    if (timeZone === 'Africa/Lagos') return 'NG';
    if (ipCountry) return ipCountry;
    return 'NG';
  }
}
