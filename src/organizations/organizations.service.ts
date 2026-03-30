import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
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

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
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
          where: { role: { slug: 'owner' } },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    // 3. Prepare Slug (Respect DTO, Fallback to Name)
    let slug = dto.slug;
    if (!slug) {
      slug = slugify(dto.name, { lower: true, strict: true });
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
        where: { slug: 'owner', scope: 'ORGANIZATION' },
      }),
      this.prisma.role.findFirstOrThrow({
        where: { slug: 'owner', scope: 'WORKSPACE' },
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
            email: dto.email ?? user.email,
            status: 'PENDING_PAYMENT',
            isActive: true,
          },
        });

        const ownerRole = await tx.role.findFirst({ where: { slug: 'owner' } });
        if (!ownerRole)
          throw new InternalServerErrorException("Role 'owner' missing");

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
      const paymentData = await this.billingService.initializePayment(
        organization.id,
        dto.planId,
        user,
      );

      return {
        organization,
        payment: paymentData,
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
      where: { id: orgId, isActive: true },
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
      members: {
        some: { userId: userId } 
      }
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
      where: { id: orgId },
      data: {
        ...dto,
        updatedAt: new Date(),
      },
    });
  }

  async deleteOrganization(orgId: string, userId: string) {
    // Soft delete organization and related data
    return this.prisma.$transaction(async (tx) => {
      // Deactivate organization
      await tx.organization.update({
        where: { id: orgId },
        data: { isActive: false, status: 'SUSPENDED' },
      });

      // Deactivate all members
      await tx.organizationMember.updateMany({
        where: { organizationId: orgId },
        data: {
          isActive: false,
        },
      });
      // Cancel any active subscriptions
      await this.billingService.cancelSubscription(orgId);

      return { success: true, message: 'Organization deleted successfully' };
    });
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
          include: { plan: true }
        },
        _count: {
          select: {
            members: true,
            workspaces: true,
          }
        }
      }
    });

    if (!org) throw new NotFoundException('Organization not found');

    const plan = org.subscription?.plan;
    const customLimits = org.subscription?.customLimits as any;

    // Calculate effective limits (Custom Enterprise overrides vs Standard Plan)
    const maxWorkspaces = customLimits?.maxWorkspaces ?? plan?.maxWorkspaces ?? 1;
    const maxTeamMembers = customLimits?.maxTeamMembers ?? plan?.maxTeamMembers ?? 1;
    const aiCreditsLimit = customLimits?.monthlyAiCredits ?? plan?.monthlyAiCredits ?? 0;

    return {
      organization: {
        id: org.id,
        name: org.name,
        status: org.status,
        createdAt: org.createdAt,
      },
      billing: {
        planName: plan?.name ?? 'Free / None',
        interval: plan?.interval ?? 'NONE',
        isActive: org.subscription?.isActive ?? false,
      },
      usage: {
        workspaces: {
          used: org._count.workspaces,
          limit: maxWorkspaces,
          isNearLimit: org._count.workspaces >= maxWorkspaces,
        },
        teamMembers: {
          used: org._count.members,
          limit: maxTeamMembers,
          isNearLimit: org._count.members >= maxTeamMembers,
        },
        aiCredits: {
          used: org.totalCreditsUsed,
          limit: aiCreditsLimit,
          isNearLimit: org.totalCreditsUsed >= (aiCreditsLimit * 0.9), // 90% warning
        }
      }
    };
  }

  // --- HELPERS ---

  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) // Run once a day
  async cleanupAbandonedOrganizations() {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - 48); // 48 Hours ago

    // Find orgs that were created > 48 hours ago but never paid
    const abandoned = await this.prisma.organization.deleteMany({
      where: {
        status: 'PENDING_PAYMENT',
        createdAt: { lt: cutoffDate }, // Older than 48 hours
      },
    });

    if (abandoned.count > 0) {
      this.logger.log(`Cleaned up ${abandoned.count} abandoned organizations.`);
    }
  }

  // Helper
  private formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
  }
}
