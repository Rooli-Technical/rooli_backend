import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
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

    const _plans = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { monthlyPriceUsd: 'asc' }, // Order by tier level
    });

    // 2. Hardcode the Free Plan
    const freePlan = {
      id: 'free-tier-static', // Static ID since it's not in DB
      name: 'Free',
      badge: 'Start for Free',
      tier: 'FREE', // Ensure this matches your PlanTier enum
      description: 'Perfect for individuals and hobbyists',
      features: ['Post Scheduling', 'Basic Analytics'],
      limits: {
        workspaces: 1,
        socialProfiles: 3, // As requested
        users: 1, // As requested
        aiCredits: 20,
      },
      pricing: {
        currency: isNigeria ? 'NGN' : 'USD',
        monthly: 0,
        annual: 0,
      },
    };

    const plans = _plans.map((plan) => {
      // Divide by 100 to convert cents/kobo back to dollars/naira
      const monthlyPrice = isNigeria
        ? plan.monthlyPriceNgn / 100
        : plan.monthlyPriceUsd / 100;

      const annualPrice = isNigeria
        ? plan.annualPriceNgn / 100
        : plan.annualPriceUsd / 100;

      // Calculate the UI metrics dynamically
      const originalAnnualPrice = monthlyPrice * 12;
      const amountSaved = Math.max(0, originalAnnualPrice - annualPrice);

      // Since you are strictly enforcing a 20% discount on all plans,
      // we can safely set this to 20 if there is any discount at all.
      const discountPercentage = amountSaved > 0 ? 20 : 0;

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
          originalAnnual: originalAnnualPrice, // Passes to UI for strikethrough
          amountSaved,
          discountPercentage,
        },
      };
    });

    return [freePlan, ...plans];
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
      include: { members: true },
    });
    const email = org.billingEmail || user?.email;
    if (!email) throw new BadRequestException('Billing email is required');

    const isMember = org.members.some(
      (member) => member.userId === finalUserId,
    );
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
  // 4. ACTIVATE SUBSCRIPTION (Webhook Handler & The Cycle Wipe)
  // ---------------------------------------------------------
  async activateSubscription(payload: any) {
    const data = payload.data;
    const { reference, amount, currency, metadata, plan, authorization, id } =
      data;

    // 👇 IDEMPOTENCY GUARD — first thing in the method
    const existing = await this.prisma.transaction.findUnique({
      where: { txRef: reference },
    });
    if (existing?.status === 'successful') {
      this.logger.log(`Webhook replay ignored for ${reference}`);
      return { org: null, isNewSignup: false };
    }

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

    // 4. DB Transaction (The Hard Reset)
    const result = await this.prisma.$transaction(async (tx) => {
      const previousSuccessCount = await tx.transaction.count({
        where: { organizationId, status: 'successful' },
      });
      const isNewSignup = previousSuccessCount === 0;

      // 🚨 UPSERT SUBSCRIPTION & WIPE ADD-ONS
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
          extraWorkspacesPurchased: 0, // Initialize at 0
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
          pendingPlanId: null,
          pendingBillingInterval: null,
          aiCreditsUsed: 0, // Wipes AI usage for the new cycle
          lastCreditResetAt: new Date(),
          extraWorkspacesPurchased: 0, // THE WIPE: Reset to 0 on every billing cycle boundary!
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
          amount: Number(amount) / 100,
          currency: currency || 'NGN',
          status: 'successful',
          paymentDate: new Date(),
        },
      });

      // UNLOCK THE ORGANIZATION
      const org = await tx.organization.update({
        where: { id: organizationId },
        data: {
          status: 'ACTIVE',
          billingStatus: 'ACTIVE',
          isActive: true,
          readOnly: false,
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

      // Unlock social profiles (Clears Day 14 Suspension locks)
      await tx.socialProfile.updateMany({
        where: { workspace: { organizationId: organizationId } },
        data: { isActive: true },
      });

      return { org, isNewSignup };
    });

    // ---------------------------------------------------------
    // 5. THE RECONCILIATION TRIGGER (Upgrades & Renewals)
    // ---------------------------------------------------------
    if (!result.isNewSignup) {
      // The transaction above just wiped `extraWorkspacesPurchased` to 0.
      // Now, we strictly enforce the base plan limits and lock any excess usage.
      try {
        await this.enforcePlanLimits(
          organizationId,
          localPlan.maxWorkspaces,
          localPlan.maxUsers,
        );
      } catch (error) {
        this.logger.error(
          `Failed to execute downgrade/renewal limits for Org ${organizationId}`,
          error,
        );
        // Note: We catch this so an error in the locking logic doesn't cause Paystack
        // to retry the webhook and double-record the transaction.
      }
    }

    // 6. Send Welcome Email Logic
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
        `Renewal/Upgrade payment processed for Org: ${organizationId}. Cycle reset complete.`,
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

    if (!sub) {
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { billingStatus: 'CANCELED' }, // Instant kill, no period end to wait for
      });
      return {
        message: 'Organization canceled (No active subscription found)',
      };
    }

    // 🚨 1. THE OVERAGE SWEEP (Your brilliant audit rule!)
    if (sub.aiOverageCostCents > 0 && sub.paystackAuthCode) {
      try {
        await this.chargeFinalOverages(sub);
      } catch (e) {
        // If it fails, log it, but DO NOT stop the cancellation process.
        this.logger.error(
          `Failed to sweep final overages for Org ${organizationId}`,
          e,
        );
      }
    }

    // 🚨 2. SAFE PAYSTACK CALL (Only if they actually have an active Paystack sub)
    if (sub.paystackSubscriptionCode && sub.paystackEmailToken) {
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
      } catch (e) {
        this.logger.error(e.response?.data);
        throw new BadRequestException(
          'Failed to disable subscription in Paystack',
        );
      }
    }

    // 🚨 3. THE DB TRANSACTION WITH THE NEW ENUM
    return await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { organizationId },
        data: {
          cancelAtPeriodEnd: true,
        },
      }),
      this.prisma.organization.update({
        where: { id: organizationId },
        // They keep full access until the cron job kills it on the final day!
        data: { billingStatus: 'PENDING_CANCELLATION' },
      }),
    ]);
  }

  // ---------------------------------------------------------
  // CHANGE PLAN (Instant Upgrades, Strict Downgrade Locks)
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

    if (!org || !org.subscription) {
      throw new BadRequestException('No subscription found');
    }

    const sub = org.subscription;
    const currentPlan = sub.plan;
    const newPlan = await this.prisma.plan.findUnique({
      where: { id: newPlanId },
    });
    if (!newPlan) throw new NotFoundException('Target plan not found');

    // 1. FREE TRIAL OVERRIDE -> INSTANT CHECKOUT (Move this to the top!)
    // If they are on a trial, they should always be able to proceed to checkout,
    // even if they are purchasing the exact plan they are currently trialing.
    if (sub.isTrial) {
      return this.initializePayment(org.id, newPlan.id, interval, user);
    }

    // 🚨 RULE 1: PREVENT SAME-STATE SELECTION
    // Now this only blocks paid users from checking out for the exact plan they already pay for.
    if (
      currentPlan.id === newPlanId &&
      sub.billingInterval === interval &&
      sub.isActive
    ) {
      throw new ConflictException(
        `You are already actively subscribed to the ${currentPlan.name} ${interval} plan.`,
      );
    }

    // Determine Upgrade vs Downgrade (Comparing base USD values)
    const isUpgrade = newPlan.monthlyPriceUsd > currentPlan.monthlyPriceUsd;

    // Also consider changing from Monthly to Annual on the SAME plan as an upgrade
    const isIntervalUpgrade =
      currentPlan.id === newPlanId &&
      interval === 'ANNUAL' &&
      sub.billingInterval === 'MONTHLY';

    // ==========================================
    // SCENARIO A: UPGRADES & INTERVAL CHANGES (Instant Reset)
    // ==========================================
    if (isUpgrade || isIntervalUpgrade) {
      // 🚨 RULE 4: INSTANT UPGRADE & RESET
      // We send them to checkout. When the Paystack webhook fires, your `activateSubscription`
      // method will overwrite `currentPeriodStart`, wipe `pendingPlanId`, and reset limits.
      // NOTE: In Paystack, to prevent double billing on their old plan, you must disable the
      // old subscription code before sending them to checkout for the new one.

      if (sub.paystackSubscriptionCode && sub.paystackEmailToken) {
        try {
          // Disable the old recurring charge so Paystack doesn't bill them twice
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
        } catch (e) {
          this.logger.error(
            `Failed to disable old subscription during upgrade for Org ${org.id}`,
          );
        }
      }

      return this.initializePayment(org.id, newPlan.id, interval, user);
    }

    // ==========================================
    // SCENARIO B: DOWNGRADES (Strictly Gated)
    // ==========================================

    // 🚨 RULE 2 & 3: THE ROCKET LOCK
    // "once on rocket plan is running there is nothing like downgrade plan but once plan expires... then the user can downgrade"
    if (currentPlan.tier === 'ROCKET' && sub.isActive) {
      throw new ForbiddenException(
        'Downgrading from the Rocket plan is not permitted while your billing cycle is active. You may downgrade after your current plan expires.',
      );
    }

    // If they bypass the lock (e.g., they are PAST_DUE or expired), enforce the limits before allowing the new checkout
    const [userCount, profileCount, workspaceCount] = await Promise.all([
      this.prisma.organizationMember.count({ where: { organizationId } }),
      this.prisma.socialProfile.count({
        where: { workspace: { organizationId }, status: 'CONNECTED' },
      }),
      this.prisma.workspace.count({ where: { organizationId } }),
    ]);

    // Pre-flight limit checks
    if (newPlan.maxUsers < 9999 && userCount > newPlan.maxUsers) {
      throw new BadRequestException(
        `Please remove ${userCount - newPlan.maxUsers} team members before switching to the ${newPlan.name} plan.`,
      );
    }
    if (
      newPlan.maxSocialProfiles < 9999 &&
      profileCount > newPlan.maxSocialProfiles
    ) {
      throw new BadRequestException(
        `Please disconnect ${profileCount - newPlan.maxSocialProfiles} profiles before switching to the ${newPlan.name} plan.`,
      );
    }
    if (
      newPlan.maxWorkspaces < 9999 &&
      workspaceCount > newPlan.maxWorkspaces
    ) {
      throw new BadRequestException(
        `Please delete ${workspaceCount - newPlan.maxWorkspaces} workspaces before switching to the ${newPlan.name} plan.`,
      );
    }

    // Since they are only allowed to downgrade AFTER expiry (meaning sub.isActive is false),
    // we don't schedule it. We send them straight to checkout to start their new, cheaper cycle.
    return this.initializePayment(org.id, newPlan.id, interval, user);
  }

  // ---------------------------------------------------------
  // 7. HANDLE FAILURES (Sets the Dunning Anchor)
  // ---------------------------------------------------------
  async handleFailedPayment(paystackData: any) {
    const { reference, amount, currency, metadata, gateway_response, id } =
      paystackData;
    const organizationId = metadata?.organizationId;
    if (!organizationId) return;

    // ✅ FIX: Use upsert + $transaction for idempotency on webhook retries
    await this.prisma.$transaction([
      this.prisma.transaction.upsert({
        where: { txRef: reference },
        create: {
          organizationId,
          txRef: reference,
          providerTxId: id.toString(),
          provider: 'PAYSTACK',
          amount: Number(amount) / 100,
          currency: currency || 'NGN',
          status: 'failed',
          paymentDate: new Date(),
        },
        update: {
          status: 'failed',
          providerTxId: id.toString(),
        },
      }),
      // 🚨 SET DUNNING ANCHOR
      this.prisma.subscription.updateMany({
        where: { organizationId },
        data: {
          status: 'PAST_DUE',
          lastPaymentFailedAt: new Date(),
          failedPaymentAttempts: { increment: 1 },
        },
      }),
    ]);

    // Send Day 0 Email
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
        features.analytics === 'basic'
          ? 'Basic Analytics'
          : 'Advanced Analytics',
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
  // REACTIVATE PAYSTACK SUBSCRIPTION
  // ---------------------------------------------------------
  async enablePaystackSubscription(
    subscriptionCode: string,
    emailToken: string,
  ) {
    try {
      const payload = {
        code: subscriptionCode,
        token: emailToken,
      };

      const { data } = await firstValueFrom(
        this.httpService.post(
          `${this.PAYSTACK_BASE_URL}/subscription/enable`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
            },
          },
        ),
      );

      this.logger.log(
        `✅ Successfully re-enabled Paystack subscription: ${subscriptionCode}`,
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to enable Paystack subscription ${subscriptionCode}`,
        error.response?.data || error.message,
      );

      // We throw an exception here so the calling method (activateOrganization)
      // knows to abort the database transaction.
      throw new BadRequestException(
        'Failed to reactivate the subscription with the payment gateway. Please contact support.',
      );
    }
  }

  // ---------------------------------------------------------
  // 8. THE DUNNING CRON JOB
  // ---------------------------------------------------------
  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
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

      // ✅ FIX: Await to prevent silent failures if the process exits early
      await Promise.allSettled(
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

      // ✅ FIX: Await to prevent silent failures if the process exits early
      await Promise.allSettled(
        doomedSubs.map((s) =>
          this.emailService.sendAccountSuspendedEmail(
            s.organization.billingEmail,
          ),
        ),
      );
    }
  }

  async verifyPayment(reference: string) {
    try {
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
    } catch (error) {
      // Re-throw NestJS exceptions (e.g. the BadRequestException above)
      if (error instanceof BadRequestException) throw error;
      this.logger.error('Payment verification failed', error?.message || error);
      throw new BadRequestException('Payment verification failed');
    }
  }

  async simulateExpiration(organizationId: string) {
    // 1. Verify the subscription exists
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });

    if (!sub) {
      throw new NotFoundException('No active subscription found for this Org.');
    }

    // 2. TIME TRAVEL: Force the database state into the past
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await this.prisma.subscription.update({
      where: { organizationId },
      data: {
        cancelAtPeriodEnd: true, // Tells the system they requested a downgrade/cancel
        currentPeriodEnd: yesterday, // Forces the expiration date to the past
      },
    });

    // 3. MANUALLY TRIGGER THE CRON JOB
    // You do not need to wait for the @Cron decorator to fire.
    // Just call the function directly!
    await this.processPendingCancellations();

    return {
      message: `Time travel successful. Organization ${organizationId} has been successfully Juked.`,
    };
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
  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processRecurringAddonsAndOverages() {
    this.logger.log('🧹 Sweeping for Add-ons and AI Overages...');

    const now = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);

    // 1. Find subs renewing tomorrow that have overages OR extra workspaces
    const subsToCharge = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        currentPeriodEnd: { gte: now, lte: tomorrow }, 
        OR: [{ aiOverageCostCents: { gt: 0 } }],
      },
      include: {
        organization: {
          select: { id: true, billingEmail: true, currency: true },
        },
      },
    });

    for (const sub of subsToCharge) {
      if (!sub.paystackAuthCode) {
        this.logger.error(`🚨 Missing auth code for org ${sub.organizationId}`);

        await this.prisma.organization.update({
          where: { id: sub.organizationId },
          data: {
            status: 'PAYMENT_METHOD_REQUIRED',
            readOnly: true,
          },
        });

        continue;
      } // Safety check

      const targetCurrency = sub.organization.currency || 'NGN';
      // Calculate Total Amount to charge (Add-on + AI Overages)
      const totalChargeBaseUnit = sub.aiOverageCostCents;

      try {
        // ✅ FIX: Deterministic reference prevents double-charging on job retries
        const reference = `rooli_addon_${sub.organizationId}_${sub.currentPeriodEnd.getTime()}`;

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
              headers: {
                Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
              },
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
                aiOverageCost: sub.aiOverageCostCents / 100,
              },
            },
          }),
          // Reset the overage counter
          this.prisma.subscription.update({
            where: { id: sub.id },
            data: { aiOverageCostCents: 0 },
          }),
        ]);
      } catch (error: any) {
        const httpStatus = error.response?.status || 500;
        this.logger.error(
          `Failed to charge add-ons for Org ${sub.organizationId}: ${error.message}`,
        );

        // 🛡️ ENTERPRISE GUARDRAIL: Is Paystack down?
        if (httpStatus >= 500) {
          this.logger.warn(
            `Paystack API unavailable (5xx Error). Skipping Org ${sub.organizationId} until tomorrow.`,
          );
          continue; // Skip to the next subscription. Do NOT suspend the user.
        }

        // 🚨 IT'S A REAL FAILURE (4xx Error: Card declined, expired, insufficient funds)
        await this.prisma.$transaction([
          this.prisma.subscription.update({
            where: { id: sub.id },
            data: {
              status: 'PAST_DUE',
              lastPaymentFailedAt: new Date(),
              failedPaymentAttempts: { increment: 1 },
            },
          }),
          // Optional: You can let your Day 8 Dunning cron handle readOnly,
          // or enforce a soft lock here. Standard practice is to leave it active
          // but PAST_DUE so they have 7 days to fix it.
        ]);

        // Alert the owner immediately
        const ownerEmail = sub.organization.billingEmail;
        if (ownerEmail) {
          await this.emailService.sendPaymentFailedEmail(
            ownerEmail,
            'Your recurring add-ons and overages',
          );
        }
      }
    }
  }

  // ---------------------------------------------------------
  // 9. PROCESS CANCELLATIONS AT PERIOD END
  // ---------------------------------------------------------
  // @Cron(CronExpression.EVERY_HOUR)
  async processPendingCancellations() {
    this.logger.log('🧹 Sweeping for end-of-period cancellations...');
    const now = new Date();

    const expiredCancellations = await this.prisma.subscription.findMany({
      where: {
        cancelAtPeriodEnd: true,
        isActive: true,
        currentPeriodEnd: { lte: now },
      },
      select: { id: true, organizationId: true },
    });

    if (expiredCancellations.length === 0) return;

    for (const sub of expiredCancellations) {
      const orgId = sub.organizationId;

      // 1. Fetch all workspaces for this org, ordered by oldest first
      const workspaces = await this.prisma.workspace.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      // 2. Identify the ones to lock (everything after index 0)
      const workspacesToLock = workspaces.slice(1).map((w) => w.id);

      // 3. Execute the "Juk" Transaction
      await this.prisma.$transaction(async (tx) => {
        // A. Mark subscription as canceled, but RESET add-ons
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: 'CANCELED',
            isActive: false,
            extraWorkspacesPurchased: 0, // 👈 Wipe the add-on ledger!
          },
        });

        // B. Update Org status to FREE/CANCELED (DO NOT SUSPEND)
        await tx.organization.update({
          where: { id: orgId },
          data: {
            // Keep them ACTIVE so they can log in, but update billing status
            status: 'ACTIVE',
            billingStatus: 'CANCELED',
          },
        });

        // C. Lock the excess workspaces
        if (workspacesToLock.length > 0) {
          await tx.workspace.updateMany({
            where: { id: { in: workspacesToLock } },
            data: { isLocked: true }, // Add an `isLocked: Boolean @default(false)` to your Prisma schema
          });

          // D. Deactivate social profiles ONLY in the locked workspaces
          await tx.socialProfile.updateMany({
            where: { workspaceId: { in: workspacesToLock } },
            data: { isActive: false },
          });
        }
      });

      this.logger.log(
        `✅ Organization ${orgId} downgraded. Premium features stripped and excess workspaces locked.`,
      );
    }
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
        'Purchasing additional workspaces is only available on the Business and Rocket plans.',
      );
    }

    // 2. CURRENCY & PRICING SETUP
    const targetCurrency = org.currency || 'NGN'; // Defaulting to your system's base
    const FX_RATE = 1470; // ₦1,470/USD as per spec
    const EXTRA_WORKSPACE_USD = 15;

    // Convert to base units (Cents for USD, Kobo for NGN)
    const basePriceBaseUnit =
      targetCurrency === 'USD'
        ? EXTRA_WORKSPACE_USD * 100 // 1500 Cents
        : EXTRA_WORKSPACE_USD * FX_RATE * 100; // 2205000 Kobo (₦22,050)

    // 3. PRORATION MATH
    const now = new Date();
    const periodEnd = new Date(sub.currentPeriodEnd);
    const periodStart = new Date(sub.currentPeriodStart);

    // Total days in their current billing cycle
    const totalDaysInCycle = Math.round(
      (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Days remaining
    const daysRemaining = Math.max(
      0,
      Math.round((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    );

    // Prorated amount: (Days Remaining / Total Days) * Base Price
    const proratedAmountBaseUnit = Math.round(
      (daysRemaining / totalDaysInCycle) * basePriceBaseUnit,
    );

    // 4. CHARGE THE USER (One-Click)
    if (!sub.paystackAuthCode) {
      throw new BadRequestException(
        'No payment method on file. Please update your billing details.',
      );
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
            headers: {
              Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
            },
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
              proratedDays: daysRemaining,
            },
          },
        }),
      ]);

      return {
        message: `Additional workspace purchased successfully.`,
        amountCharged: proratedAmountBaseUnit / 100, // Converted back to ₦ or $ for the UI response
        currency: targetCurrency,
        newTotalWorkspacesAllowed:
          sub.plan.maxWorkspaces + sub.extraWorkspacesPurchased + 1,
      };
    } catch (error: any) {
      this.logger.error(
        'Failed to charge for extra workspace',
        error.response?.data || error.message,
      );
      throw new BadRequestException(
        'Payment failed. Could not add extra workspace.',
      );
    }
  }

  async replaceCard(organizationId: string, user: any) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { subscription: true },
    });

    if (!org || !org.subscription)
      throw new BadRequestException('No active subscription');

    const targetCurrency = org.currency || 'NGN';
    // Charge a tiny authorization amount just to validate the card
    const authAmountBaseUnit = targetCurrency === 'USD' ? 50 : 5000; // 50 Cents or 50 NGN
    const reference = `rooli_update_card_${org.id}_${randomUUID()}`;

    // 1. Create a pending transaction so our webhook knows what this is for
    await this.prisma.transaction.create({
      data: {
        organizationId: org.id,
        txRef: reference,
        providerTxId: 'pending',
        provider: 'PAYSTACK',
        amount: authAmountBaseUnit / 100,
        currency: targetCurrency,
        status: 'pending',
        paymentDate: new Date(),
        metadata: { purpose: 'update_card' }, // 👈 Crucial identifier
      },
    });

    // 2. Initialize Paystack
    const payload = {
      email: org.billingEmail || user.email,
      amount: authAmountBaseUnit,
      reference,
      currency: targetCurrency,
      metadata: {
        organizationId: org.id,
        purpose: 'update_card', // 👈 Crucial identifier
      },
      callback_url: `${this.config.get('CALLBACK_URL')}/settings/billing`, // Send them back to settings
    };

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
  }

  async enforceDowngradeLimits(
    organizationId: string,
    newPlanLimitWorkspaces: number,
    newPlanLimitUsers: number,
  ) {
    // 1. WORKSPACE & PROFILE LOCKDOWN
    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId, isLocked: false },
      orderBy: { createdAt: 'asc' }, // Keep oldest alive
      select: { id: true },
    });

    if (workspaces.length > newPlanLimitWorkspaces) {
      const workspacesToLock = workspaces
        .slice(newPlanLimitWorkspaces)
        .map((w) => w.id);

      await this.prisma.$transaction([
        this.prisma.workspace.updateMany({
          where: { id: { in: workspacesToLock } },
          data: { isLocked: true },
        }),
        this.prisma.socialProfile.updateMany({
          where: { workspaceId: { in: workspacesToLock } },
          data: { isActive: false },
        }),
      ]);
    }

    // 2. USER LOCKDOWN (RBAC Hierarchy)
    // ✅ FIX: Query for isActive: true (same bug as enforcePlanLimits)
    const activeMembers = await this.prisma.organizationMember.findMany({
      where: { organizationId, isActive: true },
      include: { role: true },
    });

    if (activeMembers.length > newPlanLimitUsers) {
      const roleWeights: Record<string, number> = {
        'org-owner': 100,
        'org-admin': 90,
        'ws-owner': 80,
        'ws-editor': 70,
        'ws-contributor': 60,
        'ws-client': 50,
        'ws-viewer': 40,
        'org-member': 10,
      };

      const sortedMembers = activeMembers.sort((a, b) => {
        const weightA = roleWeights[a.role.slug] || 0;
        const weightB = roleWeights[b.role.slug] || 0;
        if (weightA !== weightB) return weightB - weightA;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const membersToSuspend = sortedMembers
        .slice(newPlanLimitUsers)
        .map((m) => m.id);

      await this.prisma.organizationMember.updateMany({
        where: { id: { in: membersToSuspend } },
        data: { isActive: false },
      });
    }
    this.logger.log(`✅ Limits enforced for Org ${organizationId}`);
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
      throw new BadRequestException(
        'You do not have any extra workspaces to cancel.',
      );
    }

    // 2. Calculate what their limit will drop to
    const baseLimit = sub.plan.maxWorkspaces;
    const newTotalLimit = baseLimit + sub.extraWorkspacesPurchased - 1;

    // 3. THE USAGE GUARDRAIL
    // If they have 6 workspaces, they can't drop their limit to 5!
    if (org._count.workspaces > newTotalLimit) {
      throw new BadRequestException(
        `You currently have ${org._count.workspaces} active workspaces. Please delete at least 1 workspace before canceling this add-on.`,
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
      message:
        'Workspace add-on successfully canceled. You will not be billed for it on your next cycle.',
      newTotalWorkspacesAllowed: newTotalLimit,
      extraWorkspacesRemaining: sub.extraWorkspacesPurchased - 1,
    };
  }

  // ---------------------------------------------------------
  // FINAL OVERAGE SWEEP (Called during cancellation)
  // ---------------------------------------------------------
  async chargeFinalOverages(sub: any) {
    // 1. Double-check that there is actually money owed and a card on file
    if (sub.aiOverageCostCents <= 0 || !sub.paystackAuthCode) {
      return;
    }

    // 2. Fetch the Organization to get the Billing Email & Currency
    // (In case the parent method didn't include it in the `sub` object)
    const org =
      sub.organization ||
      (await this.prisma.organization.findUnique({
        where: { id: sub.organizationId },
        select: { billingEmail: true, currency: true },
      }));

    if (!org?.billingEmail) {
      this.logger.error(
        `Cannot charge overages: missing billing email for Org ${sub.organizationId}`,
      );
      throw new Error('Missing billing email');
    }

    const targetCurrency = org.currency || 'NGN';
    const amountToChargeBaseUnit = sub.aiOverageCostCents; // This is already in Kobo/Cents
    // ✅ FIX: Deterministic reference prevents double-charging if cancellation retries
    const reference = `rooli_final_sweep_${sub.organizationId}_${sub.id}`;

    try {
      this.logger.log(
        `Attempting final overage sweep of ${amountToChargeBaseUnit} for Org ${sub.organizationId}...`,
      );

      // 3. Hit Paystack API to charge the saved card
      const { data: paystackResponse } = await firstValueFrom(
        this.httpService.post(
          'https://api.paystack.co/transaction/charge_authorization',
          {
            authorization_code: sub.paystackAuthCode,
            email: org.billingEmail,
            amount: amountToChargeBaseUnit,
            currency: targetCurrency,
            reference: reference,
          },
          {
            headers: {
              Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
            },
          },
        ),
      );

      const paystackData = paystackResponse.data;

      // 4. Update the Database
      await this.prisma.$transaction([
        // A. Create the Transaction Record
        this.prisma.transaction.create({
          data: {
            organizationId: sub.organizationId,
            txRef: reference,
            providerTxId: paystackData.id.toString(),
            provider: 'PAYSTACK',
            amount: amountToChargeBaseUnit / 100, // Convert back to whole NGN/USD
            currency: targetCurrency,
            status: 'successful',
            paymentDate: new Date(),
            subscriptionId: sub.id,
            metadata: {
              type: 'final_overage_sweep',
              aiOverageCost: amountToChargeBaseUnit / 100,
            },
          },
        }),

        // B. Reset the overage ledger to 0
        this.prisma.subscription.update({
          where: { id: sub.id },
          data: { aiOverageCostCents: 0 },
        }),
      ]);

      this.logger.log(
        `✅ Successfully swept final overages for Org ${sub.organizationId}`,
      );
    } catch (error: any) {
      // We throw an error so `cancelSubscription`'s catch block can log it.
      // At this stage, if it fails, the revenue is lost—but we don't want to block the cancellation.
      this.logger.error(
        `❌ Failed to charge final overages for Org ${sub.organizationId}`,
        error.response?.data || error.message,
      );
      throw new Error('Final overage charge failed');
    }
  }

  // ---------------------------------------------------------
  // UNLOCK A WORKSPACE (After manual purchase)
  // ---------------------------------------------------------
  async unlockWorkspace(organizationId: string, workspaceId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: {
          include: {
            plan: true,
          },
        },
        workspaces: { where: { isLocked: false } }, // Count currently active ones
      },
    });

    const sub = org?.subscription;
    if (!sub || !sub.isActive) {
      throw new BadRequestException(
        'You need an active premium plan to unlock workspaces.',
      );
    }

    // Base allowance + Purchased allowance
    const totalAllowed = sub.plan.maxWorkspaces + sub.extraWorkspacesPurchased;
    const currentlyActive = org.workspaces.length;

    if (currentlyActive >= totalAllowed) {
      throw new ForbiddenException(
        'You have reached your active workspace limit. Please purchase another add-on.',
      );
    }

    // Unlock it
    await this.prisma.workspace.update({
      where: { id: workspaceId, organizationId },
      data: { isLocked: false },
    });

    return { message: 'Workspace successfully unlocked.' };
  }

  // ---------------------------------------------------------
  // 10. RECONCILIATION HELPER (Runs on Renewals & Downgrades)
  // ---------------------------------------------------------
  async enforcePlanLimits(
    organizationId: string,
    allowedWorkspaces: number,
    allowedUsers: number,
  ) {
    this.logger.log(
      `Reconciling limits for Org ${organizationId}. Allowed Workspaces: ${allowedWorkspaces}, Allowed Users: ${allowedUsers}`,
    );

    // ==========================================
    // A. WORKSPACE & PROFILE LOCKDOWN
    // ==========================================
    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId, isLocked: false },
      orderBy: { createdAt: 'asc' }, // Index 0 (oldest) is the safest to keep alive
      select: { id: true },
    });

    if (workspaces.length > allowedWorkspaces) {
      const workspacesToLock = workspaces
        .slice(allowedWorkspaces)
        .map((w) => w.id);

      await this.prisma.$transaction([
        this.prisma.workspace.updateMany({
          where: { id: { in: workspacesToLock } },
          data: { isLocked: true },
        }),
        this.prisma.socialProfile.updateMany({
          where: { workspaceId: { in: workspacesToLock } },
          data: { isActive: false },
        }),
      ]);
      this.logger.log(`Locked ${workspacesToLock.length} excess workspaces.`);
    }

    // ==========================================
    // B. USER LOCKDOWN (RBAC Hierarchy)
    // ==========================================
    // ✅ FIX: Query for isActive: true
    const activeMembers = await this.prisma.organizationMember.findMany({
      where: { organizationId, isActive: true },
      include: { role: true },
    });

    if (activeMembers.length > allowedUsers) {
      const roleWeights: Record<string, number> = {
        'org-owner': 100,
        'org-admin': 90,
        'ws-owner': 80,
        'ws-editor': 70,
        'ws-contributor': 60,
        'ws-client': 50,
        'ws-viewer': 40,
        'org-member': 10,
      };

      const sortedMembers = activeMembers.sort((a, b) => {
        const weightA = roleWeights[a.role.slug] || 0;
        const weightB = roleWeights[b.role.slug] || 0;
        if (weightA !== weightB) return weightB - weightA;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const membersToSuspend = sortedMembers
        .slice(allowedUsers)
        .map((m) => m.id);

      await this.prisma.organizationMember.updateMany({
        where: { id: { in: membersToSuspend } },
        data: { isActive: false },
      });
      this.logger.log(`Suspended ${membersToSuspend.length} excess users.`);
    }
  }

  private inferCountry(ipCountry?: string, timeZone?: string) {
    if (timeZone === 'Africa/Lagos') return 'NG';
    if (ipCountry) return ipCountry;
    return 'NG';
  }
}
