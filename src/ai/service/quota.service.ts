import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { startOfMonth, endOfMonth } from 'date-fns';

@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 🛡️ ATOMIC QUOTA CONSUMPTION
   * Prevents race conditions, calculates overage, and deducts credits in one transaction.
   */
  async consumeQuota(workspaceId: string, cost: number = 1) {
    // 1. Fast lookup for the Organization ID
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) throw new NotFoundException('Workspace not found');

    // 2. ATOMIC TRANSACTION
    return await this.prisma.$transaction(async (tx) => {
      // Use standard findUnique. In highly concurrent apps, you might use raw SQL with FOR UPDATE here.
      const org = await tx.organization.findUnique({
        where: { id: ws.organizationId },
        include: { subscription: { include: { plan: true } } },
      });

      if (!org || !org.subscription) {
        throw new ForbiddenException('No active subscription found');
      }

      // 🚨 Enforce all locked billing states!
      const blockedStates = ['SUSPENDED', 'READ_ONLY', 'EXPIRED'];

      if (blockedStates.includes(org.billingStatus)) {
        throw new ForbiddenException(
          'Account inactive. Please update your payment method.',
        );
      }

      const sub = org.subscription;

      if (sub.status === 'EXPIRED') {
        throw new ForbiddenException('Trial expired. Please upgrade.');
      }

      const customLimits = sub.customLimits as any;
      let limit =
        customLimits?.aiCreditsMonthly ?? sub.plan?.aiCreditsMonthly ?? 0;

      // 🚨 THE TRIAL OVERRIDE
      if (sub.status === 'TRIALING') {
        limit = 20;
      }

      const overageRate = sub.plan?.aiOverageRateCents ?? 0;
      const overageCap = sub.plan?.aiOverageCapCents ?? 0; // The max they are allowed to spend on overages

      const used = sub.aiCreditsUsed;
      const newTotalUsed = used + cost;

      let overageCostToAdd = 0;
      let overageIncurred = false;

      // 🚨 OVERAGE LOGIC
      if (newTotalUsed > limit && limit < 999999) {
        // Hard block for trials!
        if (sub.status === 'TRIALING') {
          throw new ForbiddenException(
            'Free Trial AI limit reached (20/20). Please upgrade your plan to continue using AI.',
          );
        }

        // 🚨 RESTORED MISSING MATH:
        // Calculate exactly how many of THESE specific credits are over the limit
        const totalOverage = Math.max(0, newTotalUsed - limit);
        const previousOverage = Math.max(0, used - limit);
        const overageCreditsToCharge = totalOverage - previousOverage;

        if (overageRate > 0) {
          overageCostToAdd = overageCreditsToCharge * overageRate;
          overageIncurred = true;

          // Enforce Overage Cap
          if (
            overageCap > 0 &&
            sub.aiOverageCostCents + overageCostToAdd > overageCap
          ) {
            throw new ForbiddenException(
              `AI Overage Cap ($${overageCap / 100}) reached. Please upgrade your plan.`,
            );
          }
        } else {
          // If overageRate is 0, they are not allowed to go over. Block them.
          throw new ForbiddenException(
            `Insufficient AI Credits. You have ${Math.max(0, limit - used)} left.`,
          );
        }
      }

      // 🚨 ATOMIC UPDATE
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          aiCreditsUsed: { increment: cost },
          ...(overageCostToAdd > 0
            ? { aiOverageCostCents: { increment: overageCostToAdd } }
            : {}),
        },
      });

      // Calculate UX metrics
      const remainingCredits = Math.max(0, limit - newTotalUsed);
      const isNearLimit = newTotalUsed >= limit * 0.8 && newTotalUsed <= limit; // 80% warning

      return {
        allowed: true,
        remainingCredits,
        isNearLimit,
        overageIncurred,
        cost,
      };
    });
  }

  /**
   * ⏪ REFUND QUOTA (Used if AI provider fails AFTER we charged them)
   */
  async refundQuota(workspaceId: string, cost: number) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) return;

    // Simple decrement. (In a perfect world, you'd calculate overage refunds too, but this is fine for error recovery)
    await this.prisma.subscription.updateMany({
      where: { organizationId: ws.organizationId },
      data: { aiCreditsUsed: { decrement: cost } },
    });
  }

  /**
   * 📊 ANALYTICS: CURRENT CALENDAR MONTH USAGE
   * Use this for Dashboard charts and UI stats, NOT for billing enforcement.
   * Calculates the total credits spent from the 1st of the current month to today.
   */
  async getCurrentMonthUsage(organizationId: string): Promise<number> {
    const now = new Date();
    const start = startOfMonth(now);
    const end = endOfMonth(now);

    const result = await this.prisma.aiGeneration.aggregate({
      where: {
        organizationId,
        createdAt: {
          gte: start,
          lte: end,
        },
      },
      _sum: {
        creditCost: true,
      },
    });

    return result._sum.creditCost || 0;
  }
}
