import { PrismaService } from '@/prisma/prisma.service';
import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { startOfMonth } from 'date-fns';
import { AI_TIER_LIMITS } from '../constants/ai.constant';


@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 🛡️ THE GATEKEEPER
   * Checks if an organization has remaining credits for the current month.
   */
  async assertCanUse(workspaceId: string, feature: string): Promise<boolean> {
    const { organizationId, tier } = await this.getWorkspaceContext(workspaceId);

    // 1. Get the hard limit from your constants
    const monthlyLimit = AI_TIER_LIMITS[tier].monthlyLimit;

    // 2. Count usage across the WHOLE organization
    const usedCount = await this.getMonthlyUsageCount(organizationId);

    // 3. Throw if over limit
    if (usedCount >= monthlyLimit) {
      throw new ForbiddenException(
        `AI limit reached for your ${tier} plan (${usedCount}/${monthlyLimit}). ` +
        `Please upgrade to the next tier for more credits.`
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
    const used = await this.getMonthlyUsageCount(organizationId);
    const limit = AI_TIER_LIMITS[tier].monthlyLimit;

    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      percentage: Math.min(100, Math.round((used / limit) * 100)),
      tier,
      resetsAt: startOfMonth(new Date(new Date().setMonth(new Date().getMonth() + 1)))
    };
  }

  // --- PRIVATE HELPERS ---

  private async getMonthlyUsageCount(organizationId: string): Promise<number> {
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
}