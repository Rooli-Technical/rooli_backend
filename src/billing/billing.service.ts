import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as geoip from 'geoip-lite';
import { MailService } from '@/mail/mail.service';

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
      orderBy: isNigeria ? { priceNgn: 'asc' } : { priceUsd: 'asc' },
    });

    // Transform Data (The Magic Step)
    return plans.map((plan) => {
      return {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        tier: plan.tier,
        interval: plan.interval,
        features: plan.features,
        maxWorkspaces: plan.maxWorkspaces,

        maxSocialProfilesPerWorkspace: plan.maxSocialProfilesPerWorkspace,
        maxTeamMembers: plan.maxTeamMembers,

        monthlyAiCredits: plan.monthlyAiCredits,

        // DYNAMIC CURRENCY LOGIC
        currency: isNigeria ? 'NGN' : 'USD',
        price: isNigeria ? plan.priceNgn : plan.priceUsd,

        // We explicitly check if this plan IS available for this region
        // (e.g., maybe some plans are NGN only)
        isAvailable: isNigeria
          ? Number(plan.priceNgn) > 0
          : Number(plan.priceUsd) > 0,
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
        subscription.status === 'active' &&
        new Date() < subscription.currentPeriodEnd,
    };
  }

  // ---------------------------------------------------------
  // 3. INITIALIZE PAYMENT (Strictly NGN for now)
  // ---------------------------------------------------------
  async initializePayment(organizationId: string, planId: string, user: any) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    const email = org.billingEmail || user?.email;
    if (!email) {
      throw new BadRequestException('Billing email is required');
    }

    // FORCE NGN LOGIC
    // We strictly look for the NGN code. If it's missing, this plan isn't ready.
    if (!plan.paystackPlanCodeNgn) {
      throw new BadRequestException(
        'This plan is not configured for payments yet.',
      );
    }

    // Direct call to Paystack NGN initialization
    return this.initializePaystack(org, plan, email);
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

    // 2. Identify Plan using NGN Code
    // The webhook returns `plan.plan_code`. We check our NGN column.
    const paystackPlanCode = plan?.plan_code;
    if (!paystackPlanCode) {
      this.logger.error(`Charge ${reference} has no plan code`);
      return;
    }

    // Look up purely by the NGN code column
    const localPlan = await this.prisma.plan.findUnique({
      where: { paystackPlanCodeNgn: paystackPlanCode },
    });

    if (!localPlan) {
      this.logger.error(`Unknown Paystack NGN Plan Code: ${paystackPlanCode}`);
      return;
    }

    // 3. Calculate Dates
    const startDate = new Date();
    const endDate = new Date();
    if (localPlan.interval === 'YEARLY') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    // 4. DB Transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const previousSuccessCount = await tx.transaction.count({
        where: {
          organizationId,
          status: 'successful',
        },
      });
      const isNewSignup = previousSuccessCount === 0;

      await tx.subscription.upsert({
        where: { organizationId },
        create: {
          organizationId,
          planId: localPlan.id,
          status: 'active',
          isActive: true,
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          paystackAuthCode: authorization?.authorization_code,
        },
        update: {
          planId: localPlan.id,
          status: 'active',
          isActive: true,
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          paystackAuthCode: authorization?.authorization_code,
          cancelAtPeriodEnd: false,
        },
      });

      // Log Transaction
      await tx.transaction.create({
        data: {
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

      // Unlock Org
      const org = await tx.organization.update({
        where: { id: organizationId },
        data: { status: 'ACTIVE', isActive: true },
        include: {
          members: {
            where: { role: { slug: 'owner' } },
            include: { user: true },
            take: 1,
          },
          workspaces: {
            take: 1,
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      //unlock social profiles too
      await tx.socialProfile.updateMany({
        where: {
          workspace: { organizationId: organizationId },
        },
        data: { isActive: true },
      });

      return { org, isNewSignup };
    });

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
        `Renewal payment processed for Org: ${organizationId}. No welcome email sent.`,
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

      return this.prisma.subscription.update({
        where: { organizationId },
        data: { status: 'cancelled', cancelAtPeriodEnd: true },
      });
    } catch (e) {
      this.logger.error(e.response?.data);
      throw new BadRequestException('Cancellation failed');
    }
  }

  // ---------------------------------------------------------
  // 7. HANDLE FAILURES
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
    this.logger.warn(`Payment failed: ${gateway_response}`);
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
  // PRIVATE HELPER (NGN Initialization)
  // ---------------------------------------------------------
  private async initializePaystack(org: any, plan: any, email: string) {
    const reference = `rooli_${org.id}_${Date.now()}`;

    // NGN Logic: Paystack uses Kobo (Amount * 100)
    const amountInKobo = Number(plan.priceNgn) * 100;

    // Safety check for free plans or zero price
    if (amountInKobo <= 0) {
      throw new BadRequestException(
        'Cannot process zero value payment via gateway',
      );
    }

    const payload = {
      email,
      amount: amountInKobo,
      plan: plan.paystackPlanCodeNgn,
      reference,
      currency: 'NGN', // <--- Force NGN currency
      metadata: {
        organizationId: org.id,
        targetPlanId: plan.id,
        gateway: 'PAYSTACK',
      },
      callback_url: `${this.config.get('CALLBACK_URL')}`,
    };

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
      this.logger.error('Paystack Init Error', error.response?.data);
      throw new BadRequestException('Paystack initialization failed');
    }
  }

  async markAsExpired(paystackCode: string) {
    await this.prisma.subscription.updateMany({
      where: { paystackSubscriptionCode: paystackCode },
      data: {
        status: 'past_due', // Blocks access immediately
        isActive: false,
      },
    });
  }

  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleExpiredSubscriptions() {
    this.logger.log('🕵️ Running Daily Expiry Check...');
    const now = new Date();

    // 1. Find subscriptions that just expired
    // We fetch them first so we know WHICH orgs to lock
    const expiredSubs = await this.prisma.subscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { lt: now },
      },
      select: { id: true, organizationId: true },
    });

    if (expiredSubs.length === 0) return;

    this.logger.warn(
      `Found ${expiredSubs.length} expired subscriptions. Locking accounts...`,
    );

     for (const sub of expiredSubs) {
    await this.prisma.$transaction(async (tx) => {
      // Guarded update: only flip if still ACTIVE (prevents double-processing issues)
      const updated = await tx.subscription.updateMany({
        where: { id: sub.id, status: 'active' },
        data: { status: 'past_due', isActive: false },
      });

      // If another instance already processed it, skip locking
      if (updated.count === 0) return;

      // Lock social profiles (only those currently active)
      await tx.socialProfile.updateMany({
        where: {
          isActive: true,
          workspace: { organizationId: sub.organizationId },
        },
        data: { isActive: false },
      });

      // Optional: lock org too (helps your other queries)
      await tx.organization.update({
        where: { id: sub.organizationId },
        data: { isActive: false },
      });
    });

    this.logger.log(`🔒 Locked Organization: ${sub.organizationId}`);
  }
}

  private inferCountry(ipCountry?: string, timeZone?: string) {
    if (timeZone === 'Africa/Lagos') return 'NG';
    if (ipCountry) return ipCountry;
    return 'NG';
  }
}
