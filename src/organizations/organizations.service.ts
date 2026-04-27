import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';
import { PrismaService } from '@/prisma/prisma.service';
import slugify from 'slugify';
import { BillingService } from '@/billing/billing.service';
import { Prisma } from '@generated/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailService } from '@/mail/mail.service';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly mailService: MailService,
  ) {}

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    // 1. Update User Type (Onboarding)
    if (dto.userType) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { userType: dto.userType },
      });
    }

    // 2. Fetch User & Check Limits
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        organizationMemberships: {
          where: { role: { slug: 'org-owner' } },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const orgCount = user.organizationMemberships.length;

    if (orgCount >= 1) {
      throw new ForbiddenException('Free users can only own 1 organization');
    }

    // 3. Prepare Slug (Respect DTO, Fallback to Name)
    let slug = dto.slug;
    if (!slug) {
      slug = await this.generateUniqueOrgSlug(dto.name);
    }

    // 4. Check Uniqueness
    const existing = await this.prisma.organization.findUnique({
      where: { slug },
    });
    if (existing) {
      throw new ConflictException('Organization URL (slug) is already taken.');
    }

    let organization; // Declare outside to access in catch block

    const workspaceName = `${dto.name} Workspace`;
    const workspaceSlug = slugify(workspaceName, { lower: true, strict: true });

    const [orgOwnerRole, wsAdminRole] = await Promise.all([
      this.prisma.role.findFirstOrThrow({
        where: { slug: 'org-owner', scope: 'ORGANIZATION' },
      }),
      this.prisma.role.findFirstOrThrow({
        where: { slug: 'ws-owner', scope: 'WORKSPACE' },
      }),
    ]);

    try {
      // 5. Transaction: Create DB Record
      organization = await this.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: dto.name,
            slug,
            timezone: dto.timezone ?? 'UTC',
            billingEmail: dto.email ?? user.email,
            status: 'ACTIVE',
            isActive: true,
            billingStatus: 'TRIAL_ACTIVE',
          },
        });

        const ownerRole = await tx.role.findFirst({
          where: { slug: 'org-owner' },
        });
        if (!ownerRole) throw new NotFoundException("Role 'org-owner' missing");

        const orgMember = await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId,
            roleId: ownerRole.id,
            invitedByUserId: userId,
          },
        });

        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            slug: workspaceSlug,
            timezone: org.timezone,
            organizationId: org.id,
            members: {
              create: {
                memberId: orgMember.id,
                roleId: wsAdminRole.id,
              },
            },
          },
          include: { members: true },
        });

        return org;
      });

      // 6. Initialize Payment
      // 🚨 FIX: Start the Free Trial instead of initializing Paystack!
      await this.billingService.startTrial(organization.id, dto.planId);

      return {
        organization,
        message: 'Organization created and 14-day Free Trial started.',
      };
    } catch (err) {
      console.log(err);
      // COMPENSATING TRANSACTION:
      // If payment failed (or any other error after DB creation),
      // we should delete the 'Zombie' org so the user can retry with the same slug.
      if (organization?.id) {
        await this.prisma.organization
          .delete({ where: { id: organization.id } })
          .catch(() => {});
      }

      this.logger.error('Failed to create organization', err);
      throw err;
    }
  }

  async getOrganization(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId, isActive: true, status: 'ACTIVE' },
      include: {
        _count: {
          select: { members: true },
        },
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async getAllOrganizations(userId: string, dto: GetAllOrganizationsDto) {
    const { name, isActive, page = 1, limit = 20 } = dto;

    // Calculate pagination offsets
    const skip = (page - 1) * limit;
    const take = limit;

    const where: Prisma.OrganizationWhereInput = {
      isActive: true,
      status: 'ACTIVE',
      members: {
        some: { userId: userId },
      },
    };

    if (name) where.name = { contains: name, mode: 'insensitive' };
    if (isActive !== undefined) where.isActive = isActive;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.organization.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.organization.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async updateOrganization(orgId: string, dto: UpdateOrganizationDto) {
    return this.prisma.organization.update({
      where: { id: orgId, isActive: true },
      data: {
        ...dto,
        updatedAt: new Date(),
      },
    });
  }



async deleteOrganization(orgId: string) {
  const org = await this.prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      members: {
        where: { isActive: true },
        select: {
          user: { select: { email: true, firstName: true } },
        },
      },
    },
  });

  if (!org) throw new NotFoundException('Organization not found');

  const result = await this.prisma.$transaction(async (tx) => {
    // Soft-delete the org
    await tx.organization.update({
      where: { id: orgId },
      data: {
        isActive: false,
        status: 'SUSPENDED',
        suspendedAt: new Date(), 
      },
    });

    // Mark all members inactive
    await tx.organizationMember.updateMany({
      where: { organizationId: orgId },
      data: { isActive: false },
    });

    // 🚨 NEW: Disconnect all socials
    await tx.socialConnection.updateMany({
      where: { organizationId: orgId },
      data: { status: 'DISCONNECTED' },
    });

    await tx.socialProfile.updateMany({
      where: { workspace: { organizationId: orgId } },
      data: { status: 'DISCONNECTED', isActive: false },
    });

    return { success: true, message: 'Organization deactivated' };
  });

  // Background subscription cancellation
  this.billingService.cancelSubscription(orgId).catch((err) => {
    this.logger.error(
      `Background subscription cancellation failed for ${orgId}:`,
      err,
    );
  });

  // Notify members
  for (const member of org.members) {
    this.mailService
      .sendOrgDeletedEmail({
        to: member.user.email,
        userName: member.user.firstName,
        orgName: org.name,
      })
      .catch((err) =>
        this.logger.error(
          `Failed to send org deletion email to ${member.user.email}`,
          err,
        ),
      );
  }

  return result;
}

  async unsuspendOrganization(orgId: string) {
    const [sub, org] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { organizationId: orgId },
      }),
      this.prisma.organization.findUnique({
        where: { id: orgId },
      }),
    ]);

    if (!org) throw new NotFoundException('Organization not found');

    const now = new Date();
    // If they have no sub, or their sub ran out while they were suspended, they need to pay.
    const needsPayment = !sub || sub.currentPeriodEnd <= now;

    // 🚨 PAYSTACK CALLS REMOVED ENTIRELY
    // We assume any previous Paystack contract is either dead or untrustworthy.
    // We handle their recovery entirely through our local database.

    // ==========================================
    // FAST DATABASE TRANSACTION
    // ==========================================
    const result = await this.prisma.$transaction(async (tx) => {
      // A. If they have time left on the clock, wake up their premium features
      if (!needsPayment && sub) {
        await tx.subscription.update({
          where: { organizationId: orgId },
          data: {
            // Force the yellow banner! They must resubscribe next month.
            cancelAtPeriodEnd: true,
            status: sub.isTrial ? 'TRIALING' : 'ACTIVE',
            isActive: true,
          },
        });

        // Wake up their social profiles
        await tx.socialProfile.updateMany({
          where: { workspace: { organizationId: orgId } },
          data: { isActive: true },
        });
      }

      // B. Wake up the Organization entity
      await tx.organization.update({
        where: { id: orgId },
        data: {
          isActive: true, // Let them log in!
          readOnly: needsPayment ? true : false,
          status: needsPayment ? 'PAYMENT_METHOD_REQUIRED' : 'ACTIVE',
          billingStatus: needsPayment
            ? 'PAYMENT_METHOD_REQUIRED'
            : sub?.isTrial
              ? 'TRIAL_ACTIVE'
              : 'ACTIVE', // Matches your ENUM perfectly
        },
      });

      // C. Wake up all their team members
      await tx.organizationMember.updateMany({
        where: { organizationId: orgId },
        data: { isActive: true },
      });

      // D. Generate the Admin Report Message
      let message = 'Organization fully restored and active.';
      if (needsPayment) {
        message =
          'Organization unbanned. User must update payment method to restore full access.';
      } else if (sub) {
        message =
          'Organization restored for the remainder of their cycle. User will need to resubscribe next month.';
      }

      return { success: true, message, needsPayment };
    });

    return result;
  }

  /**
   * Returns a high-level snapshot of the organization's usage, limits, and billing.
   * Perfect for the "Settings > Overview" page.
   */
  async getOrganizationSummary(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId, isActive: true },
      include: {
        subscription: {
          include: { plan: true },
        },
        _count: {
          select: {
            members: true,
            workspaces: true,
          },
        },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');

    const plan = org.subscription?.plan;
    const customLimits = org.subscription?.customLimits as any;
    const isTrial = org.subscription?.isTrial === true;

    // Calculate effective limits (Custom Enterprise overrides vs Standard Plan)
    let maxWorkspaces = customLimits?.maxWorkspaces ?? plan?.maxWorkspaces ?? 1;
    let maxUsers = customLimits?.maxUsers ?? plan?.maxUsers ?? 1;
    let aiCreditsLimit =
      customLimits?.aiCreditsMonthly ?? plan?.aiCreditsMonthly ?? 0;
    let planName = plan?.name ?? 'Free / None';

    // 2. 🚨 TRIAL OVERRIDE
    if (isTrial) {
      planName = 'Free Trial';
      maxWorkspaces = 1;
      maxUsers = 1;
      aiCreditsLimit = 20;
    } else {
      // If NOT on trial, factor in purchased add-ons for Rocket users
      maxWorkspaces += org.subscription?.extraWorkspacesPurchased ?? 0;
    }

    return {
      organization: {
        id: org.id,
        name: org.name,
        status: org.status,
        createdAt: org.createdAt,
      },
      billing: {
        planName, // 👈 Now displays "Free Trial"
        interval: org.subscription?.billingInterval ?? 'NONE',
        isActive: org.subscription?.isActive ?? false,
        isTrial, // 👈 Good flag for the frontend to show the countdown banner!
        trialEndsAt: org.subscription?.trialEndsAt ?? null,
      },
      usage: {
        workspaces: {
          used: org._count.workspaces,
          limit: maxWorkspaces,
          isNearLimit: org._count.workspaces >= maxWorkspaces,
        },
        teamMembers: {
          used: org._count.members,
          limit: maxUsers,
          isNearLimit: org._count.members >= maxUsers,
        },
        aiCredits: {
          used: org.subscription?.aiCreditsUsed ?? 0,
          limit: aiCreditsLimit,
          isNearLimit:
            (org.subscription?.aiCreditsUsed ?? 0) >= aiCreditsLimit * 0.9,
        },
      },
    };
  }

  // --- HELPERS ---

  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupSuspendedOrganizations() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 🚨 FIX: Align with 30-Day Data Retention Policy
    // Find orgs that were suspended more than 30 days ago
    const abandonedOrgs = await this.prisma.organization.findMany({
      where: {
        status: 'SUSPENDED',
        suspendedAt: { lt: thirtyDaysAgo }, // Has been suspended for 30+ days
      },
      select: { id: true },
    });

    if (abandonedOrgs.length > 0) {
      const orgIds = abandonedOrgs.map((o) => o.id);

      // Because of database relations, it's safer to delete them
      // Ensure you have onDelete: Cascade set up in your schema!
      const deleted = await this.prisma.organization.deleteMany({
        where: { id: { in: orgIds } },
      });

      this.logger.log(
        `Data Retention Policy: Permanently deleted ${deleted.count} suspended organizations.`,
      );
    }
  }

  private async generateUniqueOrgSlug(name: string): Promise<string> {
    const baseSlug = slugify(name, { lower: true, strict: true });
    let slug = baseSlug;
    let count = 1;
    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${count++}`;
    }
    return slug;
  }
}
