import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { FeatureKey } from './types/plan-access.types';
import { RequiresUpgradeException } from '@/common/exceptions/requires-upgrade.exception';

@Injectable()
export class PlanAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // 1. SEAT LIMIT ENFORCEMENT
  // -------------------------------------------------------------
  async ensureSeatAvailable(organizationId: string, excludeEmail?: string) {
    const org = await this.getValidatedOrg(organizationId, true);
    const sub = org.subscription;
    
    // 🚨 Identify if they are "Juked"
    const isJuked = sub.status === 'CANCELED' || !sub.isActive;

    let effectiveLimit = 1;

    // 🚨 TRIAL & JUKED OVERRIDE: Strict lock to 1 User
    if (sub.isTrial || isJuked) {
      effectiveLimit = 1;
    } else {
      const activeLimit = sub.plan?.maxUsers ?? 1;
      const pendingLimit = sub.pendingPlan?.maxUsers ?? 999999;
      effectiveLimit = Math.min(activeLimit, pendingLimit);
    }

    if (effectiveLimit >= 9999) return;

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

    if (activeMembers + pendingInvites >= effectiveLimit) {
      if (sub.isTrial || isJuked) {
        throw new RequiresUpgradeException(
          'Team Collaboration',
          'Free plans are limited to 1 user. Please upgrade to the Business or Rocket plan to invite team members.',
        );
      } else {
        throw new RequiresUpgradeException(
          'Team Collaboration',
          `Seat limit reached (${effectiveLimit}). Upgrade your plan to invite more team members.`,
        );
      }
    }
  }

  // -------------------------------------------------------------
  // 2. WORKSPACE LIMIT ENFORCEMENT
  // -------------------------------------------------------------
  async ensureWorkspaceLimit(organizationId: string) {
    const org = await this.getValidatedOrg(organizationId, true);
    const sub = org.subscription;
    const isJuked = sub.status === 'CANCELED' || !sub.isActive;

    // 🚨 TRIAL & JUKED OVERRIDE: Strict lock to 1 Workspace
    if (sub.isTrial || isJuked) {
      if (org._count.workspaces >= 1) {
        throw new RequiresUpgradeException(
          'Workspace Limit',
          'Free plans are limited to 1 workspace. Please upgrade to a paid plan to add more workspaces.',
        );
      }
      return; // Exit early! Free users cannot use add-ons.
    }

    // ... (rest of your existing paid logic stays the same)
  }

  // -------------------------------------------------------------
  // 5. SOCIAL PROFILE LIMIT ENFORCEMENT
  // -------------------------------------------------------------
  async ensureSocialProfileLimit(organizationId: string, newProfileCount: number = 1) {
    const org = await this.getValidatedOrg(organizationId, true);
    const sub = org.subscription;
    const isJuked = sub.status === 'CANCELED' || !sub.isActive;

    const currentCount = await this.prisma.socialProfile.count({
      where: { workspace: { organizationId }, status: 'CONNECTED' },
    });

    // 🚨 TRIAL & JUKED OVERRIDE: Strict lock to 3 Profiles
    if (sub.isTrial || isJuked) {
      if (currentCount + newProfileCount > 3) {
        throw new RequiresUpgradeException(
          'Social Profile Limit',
          'Free plans are limited to 3 social profiles. Please upgrade to a paid plan to connect more.',
        );
      }
      return; 
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
      throw new RequiresUpgradeException(
        'Social Profile Limit',
        // Update the error message so they know they can just buy a workspace to get more profiles!
        `Social profile limit reached. Your plan allows a total of ${totalAllowed} profiles. Please purchase an additional workspace or upgrade your plan to add more.`,
      );
    }
  }

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
   * 3. FEATURE FLAG ENFORCEMENT
   */
  async ensureFeatureAccess(organizationId: string, featureKey: FeatureKey) {
    // Note: We pass `false` here because a Read-Only user should still be able
    // to *view* features they paid for, they just can't mutate data with them.
    const org = await this.getValidatedOrg(organizationId, false);

    // 🚨 TRIAL OVERRIDE: Strict lock to 1 Workspace
    if (org.subscription.isTrial) {
      // 🚨 Specific lock for Campaigns and Queue Slots (bulkScheduling)
      const lockedFeatures: FeatureKey[] = [
        'campaignPlanning',
        'queueScheduling',
        'mediaLibrary',
        'aiAdvanced',
        'aiBulkGenerate',
        'repurposeContent',
        'prioritySupport',
      ];

      if (lockedFeatures.includes(featureKey)) {
        throw new RequiresUpgradeException(String(featureKey));
      }
      const features = org.subscription.plan?.features as Record<
        string,
        boolean
      >;

      if (!features || features[featureKey] !== true) {
        throw new RequiresUpgradeException(String(featureKey));
      }
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

      throw new RequiresUpgradeException(
        'Platform Access',
        errorMessage);
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
