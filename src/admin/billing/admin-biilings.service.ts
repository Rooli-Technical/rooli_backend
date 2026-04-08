import { PrismaService } from '@/prisma/prisma.service';

import { Injectable } from '@nestjs/common';
import { UpdatePlanInput, CreatePlanInput, ManualOverrideInput, GetPaymentsInput } from './types/admin-billing.types';


const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AdminBillingService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── PLAN MANAGEMENT ───────────────────────────────────────────────────────

  /**
   * Admin can edit pricing, limits, and active status.
   * name and tier are NOT editable — enforced at the controller layer.
   */
  async updatePlan(planId: string, data: UpdatePlanInput) {
    return this.prisma.plan.update({
      where: { id: planId },
      data: {
        ...(data.monthlyPriceNgn !== undefined && { monthlyPriceNgn: data.monthlyPriceNgn }),
        ...(data.annualPriceNgn !== undefined && { annualPriceNgn: data.annualPriceNgn }),
        ...(data.monthlyPriceUsd !== undefined && { monthlyPriceUsd: data.monthlyPriceUsd }),
        ...(data.annualPriceUsd !== undefined && { annualPriceUsd: data.annualPriceUsd }),
        
        ...(data.maxWorkspaces !== undefined && { maxWorkspaces: data.maxWorkspaces }),
        ...(data.maxSocialProfiles !== undefined && { maxSocialProfiles: data.maxSocialProfiles }),
        ...(data.maxUsers !== undefined && { maxUsers: data.maxUsers }),
        ...(data.aiCreditsMonthly !== undefined && { aiCreditsMonthly: data.aiCreditsMonthly }),
        
        ...(data.aiOverageRateCents !== undefined && { aiOverageRateCents: data.aiOverageRateCents }),
        ...(data.aiOverageCapCents !== undefined && { aiOverageCapCents: data.aiOverageCapCents }),
        ...(data.features !== undefined && { features: data.features }),
        ...(data.allowedPlatforms !== undefined && { allowedPlatforms: data.allowedPlatforms }),

        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  }

  async getPlans() {
    return this.prisma.plan.findMany({
      orderBy: { monthlyPriceNgn: 'asc' }, 
    });
  }

  async getPlanById(planId: string) {
    return this.prisma.plan.findUniqueOrThrow({
      where: { id: planId },
    });
  }

  async createPlan(data: CreatePlanInput) {
    return this.prisma.plan.create({
      data: {
        name: data.name,
        description: data.description,
        tier: data.tier,
        
        //  Mapped to your new Pricing fields
        monthlyPriceNgn: data.monthlyPriceNgn,
        annualPriceNgn: data.annualPriceNgn,
        monthlyPriceUsd: data.monthlyPriceUsd,
        annualPriceUsd: data.annualPriceUsd,
        
        //  Mapped to your new Limit fields
        maxWorkspaces: data.maxWorkspaces ?? 1,
        maxSocialProfiles: data.maxSocialProfiles ?? 3,
        maxUsers: data.maxUsers ?? 1,
        
        //  Mapped to your new AI fields
        aiCreditsMonthly: data.aiCreditsMonthly ?? 100,
        aiOverageRateCents: data.aiOverageRateCents ?? 0,
        aiOverageCapCents: data.aiOverageCapCents ?? null,
        
        //  Features & Platforms
        features: data.features ?? {},
        allowedPlatforms: data.allowedPlatforms ?? ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER'],

        //  Mapped to your specific Gateway fields
        paystackPlanCodeMonthlyNgn: data.paystackPlanCodeMonthlyNgn,
        paystackPlanCodeAnnualNgn: data.paystackPlanCodeAnnualNgn,
        paystackPlanCodeMonthlyUsd: data.paystackPlanCodeMonthlyUsd,
        paystackPlanCodeAnnualUsd: data.paystackPlanCodeAnnualUsd,
      },
    });
  }

  // ─── MANUAL OVERRIDES ──────────────────────────────────────────────────────

  async applyManualOverride(input: ManualOverrideInput) {
    const subscription = await this.prisma.subscription.findUniqueOrThrow({
      where: { organizationId: input.organizationId },
    });

    let newPeriodEnd: Date;

    if (input.overrideType === 'extend_trial') {
      const base =
        subscription.currentPeriodEnd > new Date()
          ? subscription.currentPeriodEnd
          : new Date();
      newPeriodEnd = new Date(base.getTime() + ONE_WEEK_MS); //  ONE_WEEK_MS is now defined
    } else {
      if (!input.customEndDate) {
        throw new Error('customEndDate is required for custom_end_date override');
      }
      if (input.customEndDate <= new Date()) {
        throw new Error('customEndDate must be in the future');
      }
      newPeriodEnd = input.customEndDate;
    }

    return this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodEnd: newPeriodEnd,
        status: 'ACTIVE', // Fixed enum casing
        isActive: true,
        cancelAtPeriodEnd: false,
      },
      include: { organization: true, plan: true },
    });
  }

  // ─── BILLING METRICS ───────────────────────────────────────────────────────

  async getBillingMetrics() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const activeSubsWithPlan = await this.prisma.subscription.findMany({
      where: { isActive: true },
      include: { plan: { select: { monthlyPriceNgn: true } } }, //  Fixed to monthlyPriceNgn
    });

    const mrr = activeSubsWithPlan.reduce(
      (sum, sub) => sum + Number(sub.plan.monthlyPriceNgn || 0), //  Fixed to monthlyPriceNgn
      0,
    );
    const arr = mrr * 12;

    const [canceledThisMonth, totalActiveLastMonth, flagged] =
      await Promise.all([
        this.prisma.subscription.count({
          where: { status: 'CANCELED', updatedAt: { gte: startOfMonth } }, //  Fixed enum casing
        }),
        this.prisma.subscription.count({
          where: { isActive: true, createdAt: { lt: startOfMonth } },
        }),
        this.prisma.transaction.count({
          where: { status: { in: ['failed', 'abandoned', 'incomplete'] } },
        }),
      ]);

    const churnRate =
      totalActiveLastMonth > 0
        ? parseFloat(((canceledThisMonth / totalActiveLastMonth) * 100).toFixed(1))
        : 0;

    return { mrr, arr, churnRate, flagged };
  }

  // ─── PAYMENT HISTORY ───────────────────────────────────────────────────────

  async getPaymentHistory({ search, page = 1, limit = 20 }: GetPaymentsInput = {}) {
    const skip = (page - 1) * limit;

    const where = search
      ? {
          OR: [
            {
              organization: {
                name: { contains: search, mode: 'insensitive' as const },
              },
            },
            { txRef: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    // Batch-fetch subscriptions instead of N+1 queries
    const orgIds = transactions.map((tx) => tx.organizationId);
    const subscriptions = await this.prisma.subscription.findMany({
      where: { organizationId: { in: orgIds } },
      select: {
        organizationId: true,
        plan: { select: { name: true, tier: true } },
      },
    });

    const subMap = Object.fromEntries(
      subscriptions.map((s) => [s.organizationId, s.plan]),
    );

    const enriched = transactions.map((tx) => ({
      ...tx,
      planName: subMap[tx.organizationId]?.name ?? 'Unknown',
      planTier: subMap[tx.organizationId]?.tier ?? 'Unknown',
    }));

    return {
      data: enriched,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  // ─── CREATE INVOICE ────────────────────────────────────────────────────────

  async createInvoice(input: {
    organizationId: string;
    amount: number;
    currency?: string;
    txRef: string;
    invoiceUrl?: string;
  }) {
    return this.prisma.transaction.create({
      data: {
        organizationId: input.organizationId,
        amount: input.amount,
        currency: input.currency ?? 'NGN',
        status: 'successful', 
        txRef: input.txRef,
        provider: 'MANUAL',
        providerTxId: input.txRef,
        invoiceUrl: input.invoiceUrl,
      },
      include: { organization: true },
    });
  }

}
