import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { addMonths, startOfMonth } from 'date-fns';
import { AI_COSTS, AI_TIER_LIMITS } from '../constants/ai.constant';
import { AiFeature } from '@generated/enums';


@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 🛡️ THE GATEKEEPER
   * Checks if an organization has remaining credits for the current month.
   */
  async assertCanUse(workspaceId: string, feature: AiFeature, count: number = 1): Promise<boolean> {
    const { organizationId, tier } = await this.getWorkspaceContext(workspaceId);
    const limit = AI_TIER_LIMITS[tier].monthlyCredits;


    const cost = this.getFeatureCost(feature, count);

    // 2. Count usage across the WHOLE organization
    const usage = await await this.getCurrentMonthUsage(organizationId);

    // 3. Throw if over limit
   if (usage + cost > limit) {
      throw new ForbiddenException(
        `Insufficient AI Credits. This action costs ${cost} credits, but you only have ${limit - usage} left.`
      );
    }

    return true;
  }

  /**
   * 📊 USAGE DATA FOR UI
   * Returns a breakdown to show in the user's dashboard.
   */
async getQuotaStatus(workspaceId: string) {
  const { organizationId, tier } = await this.getWorkspaceContext(workspaceId);
  
  const used = await this.getCurrentMonthUsage(organizationId); 
  
  const limit = AI_TIER_LIMITS[tier].monthlyCredits; 

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentage: Math.min(100, Math.round((used / limit) * 100)),
    tier,
    resetsAt: startOfMonth(addMonths(new Date(), 1))
  };
}

  // --- PRIVATE HELPERS ---

 async getMonthlyUsageCount(organizationId: string): Promise<number> {
    return this.prisma.aiGeneration.count({
  where: { organizationId, createdAt: { gte: startOfMonth(new Date()) } },
});
  }

  private async getWorkspaceContext(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        organizationId: true,
        organization: {
          select: {
            subscription: {
              select: { plan: { select: { tier: true } } }
            }
          }
        }
      }
    });

    if (!ws) throw new NotFoundException('Workspace not found');

    const tier = (ws.organization?.subscription?.plan?.tier ?? 'CREATOR') as 
      'CREATOR' | 'BUSINESS' | 'ROCKET';

    return { organizationId: ws.organizationId, tier };
  }

  /**
   * Calculate total credits used this month
   */
private async getCurrentMonthUsage(organizationId: string): Promise<number> {
  const start = startOfMonth(new Date());

  const result = await this.prisma.aiGeneration.aggregate({
    where: {
      organizationId, // 👈 Check the whole org, not just one workspace
      createdAt: { gte: start },
    },
    _sum: {
      creditCost: true, 
    },
  });

  return result._sum.creditCost || 0;
}

  private getFeatureCost(feature: AiFeature | string, count: number = 1): number {
    const baseCost = AI_COSTS[feature] ?? 1; 

    // For features like 'BULK', you might want to multiply cost by count
    // For single actions, count defaults to 1.
    if (feature === 'BULK' || feature === 'VARIANTS') {
       // Example logic: Base cost + small fee per additional item
       return baseCost + (count > 1 ? (count - 1) * 0.5 : 0);
    }

    return baseCost * count;
  }
}