import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { FeatureKey } from './types/plan-access.types';

@Injectable()
export class PlanAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 0. THE MASTER HELPER
   * Fetches the Org, Sub, and Plan, and handles all billing status checks in one place.
   */
  private async getValidatedOrg(
    organizationId: string,
    enforceActiveBilling = true,
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true, pendingPlan: true } },
        _count: { select: { workspaces: true } },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');
    if (!org.subscription)
      throw new ForbiddenException('No active subscription found');

    if (enforceActiveBilling) {
      if (org.billingStatus === 'SUSPENDED') {
        throw new ForbiddenException(
          'Account suspended. Please update payment method.',
        );
      }
      if (org.billingStatus === 'READ_ONLY') {
        throw new ForbiddenException(
          'Account is read-only. Please update payment method.',
        );
      }
    }

    return org;
  }

  /**
   * 1. SEAT LIMIT ENFORCEMENT
   */
  async ensureSeatAvailable(organizationId: string, excludeEmail?: string) {
    // Fetch and validate in one line
    const org = await this.getValidatedOrg(organizationId, true);

    const sub = org.subscription;

    // 1. Determine the effective limit
    let effectiveLimit = 1;

    // 🚨 TRIAL OVERRIDE: Strict lock to 1 User
    if (sub.isTrial) {
      effectiveLimit = 1;
    } else {
      // 2. PAID-TO-PAID LOGIC
      const activeLimit = sub.plan?.maxUsers ?? 1;
      const pendingLimit = sub.pendingPlan?.maxUsers ?? 999999;
      effectiveLimit = Math.min(activeLimit, pendingLimit);
    }

    // Unlimited check (Enterprise)
    if (effectiveLimit >= 9999) return;

    // 🚀 PERFORMANCE FIX: Run both count queries simultaneously
    const [activeMembers, pendingInvites] = await Promise.all([
      this.prisma.organizationMember.count({ where: { organizationId } }),
      this.prisma.invitation.count({
        where: {
          organizationId,
          status: 'PENDING',
          ...(excludeEmail ? { email: { not: excludeEmail } } : {}),
        },
      }),
    ]);

    // 3. Enforce the limit
    if (activeMembers + pendingInvites >= effectiveLimit) {
      if (sub.isTrial) {
        throw new ForbiddenException(
          'Free trials are limited to 1 user. Please upgrade to the Business or Rocket plan to invite team members.',
        );
      } else {
        throw new ForbiddenException(
          `Seat limit reached (${effectiveLimit}). Upgrade your plan to invite more team members.`,
        );
      }
    }
  }

  /**
   * 2. WORKSPACE LIMIT ENFORCEMENT
   */
  async ensureWorkspaceLimit(organizationId: string) {
    // Fetch and validate in one line
    const org = await this.getValidatedOrg(organizationId, true);

    const sub = org.subscription;

    // 🚨 1. TRIAL OVERRIDE: Strict lock to 1 Workspace
    if (sub.isTrial) {
      if (org._count.workspaces >= 1) {
        throw new ForbiddenException(
          // 🚨 FIX 1: Tell them to upgrade to ANY paid plan, not just Rocket
          'Free trials are limited to 1 workspace. Please upgrade to a paid plan to add more workspaces.',
        );
      }
      return; // Exit early! Trial users cannot use pending plans or add-ons.
    }

    const customLimits = sub.customLimits as any;
    const activeLimit = sub.plan?.maxWorkspaces ?? 1;
    const pendingLimit = sub.pendingPlan?.maxWorkspaces ?? 999999;

    const effectiveLimit = Math.min(activeLimit, pendingLimit);

    if (effectiveLimit >= 9999) return;

    // Check standard limit + any extra add-ons purchased
    const totalAllowed = effectiveLimit + (sub.extraWorkspacesPurchased ?? 0);

    if (org._count.workspaces >= totalAllowed) {
      if (sub.pendingPlanId && activeLimit > pendingLimit) {
        throw new ForbiddenException(
          `Creating this workspace exceeds your scheduled downgrade limits. Please cancel your pending downgrade to continue.`,
        );
      } else {
        throw new ForbiddenException(
          // 🚨 FIX 2: Since they are already on Business/Rocket, just tell them to buy the add-on!
          `Workspace limit reached (${totalAllowed}). Please purchase an additional workspace to continue.`,
        );
      }
    }
  }

  /**
   * 3. FEATURE FLAG ENFORCEMENT
   */
  async ensureFeatureAccess(organizationId: string, featureKey: FeatureKey) {
    // Note: We pass `false` here because a Read-Only user should still be able
    // to *view* features they paid for, they just can't mutate data with them.
    const org = await this.getValidatedOrg(organizationId, false);

    const features = org.subscription.plan?.features as Record<string, boolean>;

    if (!features || features[featureKey] !== true) {
      throw new ForbiddenException(
        `Your current plan does not include access to: ${String(featureKey)}. Please upgrade.`,
      );
    }
  }

  /**
   * 4. PLATFORM ACCESS ENFORCEMENT
   */
  async ensurePlatformAllowed(
    organizationId: string,
    platform: string /* or Platform */,
  ) {
    // We pass `true` because connecting a new social account is a MUTATION.
    // If they are in Read-Only mode or Suspended, they shouldn't be able to do this.
    const org = await this.getValidatedOrg(organizationId, true);

    const isTrial = org.subscription.isTrial;
    let allowedPlatforms = org.subscription.plan?.allowedPlatforms || [];

    //  Trial override: Override the plan's default platforms if they are on a trial
    if (isTrial) {
      // Adjust this array to exactly match whatever your spec dictates for trials!
      allowedPlatforms = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'];
    }

    if (!allowedPlatforms.includes(platform as any)) {
      // 🚀 UX Polish: Give them a specific error message if they are on a trial
      const errorMessage = isTrial
        ? `${platform} is not available during the Free Trial. Please upgrade your plan to unlock this platform.`
        : `Your current plan does not support connecting ${platform} accounts. Please upgrade.`;

      throw new ForbiddenException(errorMessage);
    }
  }

  /**
   * 5. SOCIAL PROFILE LIMIT ENFORCEMENT
   */
async ensureSocialProfileLimit(
    organizationId: string,
    newProfileCount: number = 1,
  ) {
    const org = await this.getValidatedOrg(organizationId, true);

    const sub = org.subscription;

    // Count currently connected profiles across the whole organization
    const currentCount = await this.prisma.socialProfile.count({
      where: {
        workspace: { organizationId },
        status: 'CONNECTED',
      },
    });

    // 🚨 2. TRIAL OVERRIDE: Strict lock to 3 Profiles
    if (sub.isTrial) {
      if (currentCount + newProfileCount > 3) {
        throw new ForbiddenException(
          'Free trials are limited to 3 social profiles. Please upgrade to a paid plan to connect more.',
        );
      }
      return; // Exit early! Trial users cannot use add-ons or pending plans.
    }

    // 🚨 Match the new schema name: maxSocialProfiles
    const activeLimit = sub.plan?.maxSocialProfiles ?? 0;
    const pendingLimit = sub.pendingPlan?.maxSocialProfiles ?? 999999;

    const effectiveLimit = Math.min(activeLimit, pendingLimit);

    if (effectiveLimit >= 9999) return;

    // 🚨 THE FIX: Calculate the bonus profiles from add-ons (4 per extra workspace)
    const bonusProfiles = (sub.extraWorkspacesPurchased ?? 0) * 4;
    const totalAllowed = effectiveLimit + bonusProfiles;


    // 🚨 THE FIX: Check against 'totalAllowed' instead of 'effectiveLimit'
    if (currentCount + newProfileCount > totalAllowed) {
      throw new ForbiddenException(
        // Update the error message so they know they can just buy a workspace to get more profiles!
        `Social profile limit reached. Your plan allows a total of ${totalAllowed} profiles. Please purchase an additional workspace or upgrade your plan to add more.`,
      );
    }
  }

  /**
   * 6. GENERIC MUTATION ENFORCEMENT
   * Ensures the organization is neither Suspended nor Read-Only.
   */
  async ensureActiveBilling(organizationId: string) {
    // getValidatedOrg with 'true' automatically throws 403 if Suspended or Read-Only
    await this.getValidatedOrg(organizationId, true);
  }
}
