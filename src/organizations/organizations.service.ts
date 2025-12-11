import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateOrganizationDto } from './dtos/create-organization.dto';
import { UpdateOrganizationDto } from './dtos/update-organization.dto';
import { OrganizationUsageDto } from './dtos/organization-usage.dto';
import { OrganizationStatsDto } from './dtos/organization-stats.dto';
import { GetAllOrganizationsDto } from './dtos/get-organiations.dto';
import { PrismaService } from '@/prisma/prisma.service';
import slugify from 'slugify';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    try {
      const ownedMemberships = await this.prisma.organizationMember.findMany({
        where: {
          userId: userId,
          role: { name: 'OWNER' }, // Only count orgs they OWN, not ones they were invited to
        },
        include: { organization: true },
      });
      const ownedCount = ownedMemberships.length;
      if (ownedCount >= 1) {
    // They already have a workspace. Check if they are allowed another.
    
    // Check if ANY of their owned orgs is an AGENCY tier
    // (Or checking the specific "Billing" org if you separate them)
    const hasAgencyPlan = ownedMemberships.some(
      m => m.organization.planTier === 'AGENCY'
    );

    if (!hasAgencyPlan) {
      throw new ForbiddenException(
        "You are on the FREE plan. You can only manage 1 Workspace. Upgrade to Agency to create more."
      );
    }
  }
      const slug = slugify(dto.name, { lower: true, strict: true });

      // Check if slug is available
      const existing = await this.prisma.organization.findUnique({
        where: { slug },
      });

      if (existing) {
        throw new ConflictException('Organization slug already exists');
      }

      // Create organization and make user the owner
      return await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            timezone: dto.timezone || 'UTC',
            email: dto.email,
            planTier: 'FREE',
            planStatus: 'ACTIVE',
            maxMembers: 5, // Default limit
            monthlyCreditLimit: 1000, // Default credits
          },
        });

        const ownerRole = await tx.role.findFirst({
          where: { name: 'owner' },
        });

        if (!ownerRole) {
          throw new NotFoundException(
            "Role 'owner' does not exist. Seed your roles table first.",
          );
        }

        // Add user as owner
        await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: userId,
            roleId: ownerRole.id,
            invitedBy: userId,
          },
        });

        // Create default brand kit
        await tx.brandKit.create({
          data: {
            organizationId: organization.id,
            name: 'Our Brand',
          },
        });

        return organization;
      });
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  async getOrganization(orgId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: orgId,
        isActive: true,
      },
      include: {
        organization: {
          include: {
            _count: {
              select: {
                members: { where: { isActive: true } },
                posts: true,
                aiContentGenerations: true,
                aiImageGenerations: true,
              },
            },
          },
        },
      },
    });

    if (!membership) {
      throw new NotFoundException('Organization not found or access denied');
    }

    return membership.organization;
  }

  async getAllOrganizations(dto: GetAllOrganizationsDto) {
    const { name, isActive, planTier, planStatus, page, limit } = dto;

    // Calculate pagination offsets
    const skip = (page - 1) * limit;
    const take = limit;

    const where: any = {};

    if (name) where.name = { contains: name, mode: 'insensitive' };
    if (isActive !== undefined) where.isActive = isActive;
    if (planTier) where.planTier = planTier;
    if (planStatus) where.planStatus = planStatus;

    const organizations = await this.prisma.organization.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });

    return organizations;
  }

  async updateOrganization(
    orgId: string,
    userId: string,
    dto: UpdateOrganizationDto,
  ) {
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
        data: { isActive: false },
      });

      // Deactivate all members
      await tx.organizationMember.updateMany({
        where: { organizationId: orgId },
        data: { isActive: false },
      });

      // Cancel any active subscriptions
      //await this.cancelSubscription(orgId);

      return { success: true, message: 'Organization deleted successfully' };
    });
  }

  async getOrganizationUsage(orgId: string): Promise<OrganizationUsageDto> {
    // Validation
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { maxMembers: true, monthlyCreditLimit: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    // 2. Parallel Count Queries
    const [memberCount, creditUsage, postCount, mediaStorage] =
      await Promise.all([
        this.prisma.organizationMember.count({
          where: { organizationId: orgId, isActive: true },
        }),
        // Sum of tokens
        this.prisma.aIUsage.aggregate({
          where: { organizationId: orgId },
          _sum: { tokensUsed: true },
        }),
        // Count posts
        this.prisma.post.count({ where: { organizationId: orgId } }),
        // Sum file size (Storage usage)
        this.prisma.mediaFile.aggregate({
          where: { organizationId: orgId },
          _sum: { size: true },
        }),
      ]);

    return {
      memberCount,
      creditUsage: creditUsage._sum.tokensUsed || 0,
      postCount,
      mediaStorage: mediaStorage._sum.size || 0, // in bytes
      maxMembers: org.maxMembers,
      monthlyCreditLimit: org.monthlyCreditLimit,
    };
  }

  //this should be in the analytics module

  async checkMemberLimit(orgId: string): Promise<boolean> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { maxMembers: true },
    });

    const memberCount = await this.prisma.organizationMember.count({
      where: { organizationId: orgId, isActive: true },
    });

    return memberCount < organization.maxMembers;
  }

  // private async verifyOwnership(orgId: string, userId: string) {
  //   let ownerRole = await this.prisma.role.findUnique({
  //     where: { name: 'OWNER' },
  //   });

  //   const membership = await this.prisma.organizationMember.findFirst({
  //     where: {
  //       organizationId: orgId,
  //       userId: userId,
  //       roleId: ownerRole.id,
  //       isActive: true,
  //     },
  //   });

  //   if (!membership) {
  //     throw new ForbiddenException(
  //       'Only organization owners can perform this action',
  //     );
  //   }
  // }

  private async verifyMembership(orgId: string, userId: string) {
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: orgId,
        userId: userId,
        isActive: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('Organization access denied');
    }
  }

  private async cancelSubscription(orgId: string) {
    // Integrate with your billing service (Stripe, etc.)
    // This is a placeholder implementation
    console.log(`Canceling subscription for organization ${orgId}`);
  }
}
