import { PrismaService } from '@/prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, catchError } from 'rxjs';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------
  // 1. GET AVAILABLE PLANS
  // ---------------------------------------------------------
  async getAvailablePlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        currency: true,
        interval: true,
        features: true,
      },
    });
  }

  // ---------------------------------------------------------
  // 2. GET CURRENT SUBSCRIPTION
  // ---------------------------------------------------------
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
  // 3. INITIALIZE PAYMENT (Upgrade)
  // ---------------------------------------------------------
  async initializePayment(organizationId: string, planId: string, user:any) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    const email = org.billingEmail || user?.email;

    if (!email) {
      throw new BadRequestException(
        'A billing email is required to process payments.',
      );
    }

    const txRef = `rooli_${organizationId}_${Date.now()}`;

    const payload = {
      tx_ref: txRef,
      amount: plan.price.toString(),
      currency: plan.currency,
      payment_plan: plan.flutterwavePlanId,
      redirect_url: `${this.config.get('FRONTEND_URL')}/billing/callback`,
      customer: {
        email: email || user?.email,
        name: org.name,
      },
      meta: {
        organizationId: organizationId,
        targetPlanId: plan.id,
      },
      customizations: {
        title: `Upgrade to ${plan.name}`,
        logo: 'https://your-rooli-url.com/logo.png',
      },
    };

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .post(`${this.FLUTTERWAVE_BASE_URL}/payments`, payload, {
            headers: {
              Authorization: `Bearer ${this.config.get('FLUTTERWAVE_SECRET_KEY')}`,
            },
          })
          .pipe(
            catchError((error) => {
              this.logger.error('Flutterwave Init Error', error.response?.data);
              throw new BadRequestException('Payment initialization failed');
            }),
          ),
      );

      return {
        paymentUrl: data.data.link,
        txRef,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(
        'Could not connect to payment provider',
      );
    }
  }

  // ACTIVATE SUBSCRIPTION (Webhook)
  async activateSubscription(organizationId: string, payload: any) {
    const {
      id: flutterwaveTxId,
      tx_ref,
      amount,
      currency,
      payment_plan,
      card,
    } = payload;

    //  PLAN VALIDATION
    const plan = await this.prisma.plan.findUnique({
      where: { flutterwavePlanId: payment_plan?.toString() },
    });

    if (!plan) {
      this.logger.error(`Webhook received for unknown Plan ID: ${payment_plan}`);
      return;
    }

    //  EXTRACT SUBSCRIPTION ID
    const fwSubscriptionId =
      payload.subscription_id ||
      payload.subscription?.id ||
      flutterwaveTxId.toString();

    //  CALCULATE DATES
    const startDate = new Date();
    const endDate = new Date();

    if (plan.interval === 'yearly') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    // 4. DB TRANSACTION
    return this.prisma.$transaction(async (tx) => {
      // A. Create/Update Subscription
      const subscription = await tx.subscription.upsert({
        where: { organizationId },
        create: {
          organizationId,
          planId: plan.id,
          flutterwaveId: fwSubscriptionId.toString(),
          status: 'active',
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          cardToken: card?.token,
        },
        update: {
          planId: plan.id,
          flutterwaveId: fwSubscriptionId.toString(),
          status: 'active',
          currentPeriodStart: startDate,
          currentPeriodEnd: endDate,
          cardToken: card?.token,
          cancelAtPeriodEnd: false,
        },
      });

      // B. Create Invoice Record
      await tx.transaction.create({
        data: {
          organizationId,
          txRef: tx_ref,
          flutterwaveTxId: flutterwaveTxId.toString(),
          amount: Number(amount),
          currency: currency,
          status: 'successful',
          paymentDate: new Date(),
        },
      });

      // C. Unlock Social Accounts (If they were paused)
      await tx.socialAccount.updateMany({
        where: { organizationId },
        data: { isActive: true, errorMessage: null },
      });

      // This flips the status from 'PENDING_PAYMENT' to 'ACTIVE'
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          status: 'ACTIVE',
          isActive: true,  
        }
      });

      this.logger.log(`Subscription activated & Org unlocked: ${organizationId}`);
      return subscription;
    });
  }

  // ---------------------------------------------------------
  // 5. CANCEL SUBSCRIPTION
  // ---------------------------------------------------------
  async cancelSubscription(organizationId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { organizationId },
    });

    if (!sub || sub.status !== 'active') {
      throw new BadRequestException('No active subscription found to cancel');
    }

    if (!sub.flutterwaveId) {
      throw new BadRequestException(
        'Cannot cancel automatically. Contact support.',
      );
    }

    try {
      await firstValueFrom(
        this.httpService
          .put(
            `${this.FLUTTERWAVE_BASE_URL}/subscriptions/${sub.flutterwaveId}/cancel`,
            {},
            {
              headers: {
                Authorization: `Bearer ${this.config.get('FLUTTERWAVE_SECRET_KEY')}`,
              },
            },
          )
          .pipe(
            catchError((error) => {
              this.logger.error('FW Cancel Error', error.response?.data);
              throw new BadRequestException(
                'Failed to cancel subscription with provider',
              );
            }),
          ),
      );

      return this.prisma.subscription.update({
        where: { organizationId },
        data: {
          status: 'cancelled',
          cancelAtPeriodEnd: true,
        },
      });
    } catch (error) {
      // Log the specific error for debugging
      this.logger.error(`Cancellation failed for Org ${organizationId}`, error);
      throw error;
    }
  }
}
