import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import dayjs from 'dayjs';
import { BillingService } from '@/billing/billing.service';
import { ListMembersQueryDto } from './dtos/list-members.dto';
import { Prisma, RoleScope } from '@generated/client';

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
        if (!ownerRole) throw new InternalServerErrorException("Role 'owner' missing");

        await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId,
            roleId: ownerRole.id,
            invitedByUserId: userId,
          },
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
        await this.prisma.organization.delete({ where: { id: organization.id } }).catch(() => {});
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

  async getAllOrganizations(dto: GetAllOrganizationsDto) {
    const { name, isActive, page, limit } = dto;

    // Calculate pagination offsets
    const skip = (page - 1) * limit;
    const take = limit;

    const where: any = {};

    if (name) where.name = { contains: name, mode: 'insensitive' };
    if (isActive !== undefined) where.isActive = isActive;

    const organizations = await this.prisma.organization.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });

    return organizations;
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
     await tx.organization.update({
        where: { id: orgId },
        data: { 
          isActive: false, 
          status: 'SUSPENDED' 
        },
      });
      // Cancel any active subscriptions
      //await this.cancelSubscription(orgId);

      return { success: true, message: 'Organization deleted successfully' };
    });
  }

  async listOrganizationMembers(params: {
  organizationId: string;
  query?: ListMembersQueryDto; 
}) {
  const { organizationId, query } = params;

  // 1. Verify Organization exists
  const organization = await this.prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!organization) throw new NotFoundException('Organization not found');

  // 2. Pagination Logic
  const take = Math.min(query?.limit ?? 20, 100);
  const skip = ((query?.page ?? 1) - 1) * take;

  // 3. Search Filter (Email, First Name, Last Name)
  const search = query?.search?.trim();
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId,
    ...(search
      ? {
          user: {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  // 4. Execute Fetch
  const [items, total] = await this.prisma.$transaction([
    this.prisma.organizationMember.findMany({
      where,
      take,
      skip,
      orderBy: { createdAt: 'desc' },
      include: {
        role: true, // The Organization-level role (e.g., Owner, Admin, Member)
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            avatar: true,
            lastActiveAt: true,
          },
        },
      },
    }),
    this.prisma.organizationMember.count({ where }),
  ]);

  return {
    items,
    meta: {
      total,
      page: query?.page ?? 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    },
  };
}

async updateRole(params: {
    organizationId: string;
    memberId: string; // Who is being promoted?
    roleId: string; // The new role
  }) {
    const { organizationId, memberId, roleId } = params;

    // 1. Validation: Ensure Role is valid for ORGANIZATION scope
    const newRole = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!newRole || newRole.scope !== RoleScope.ORGANIZATION) {
      throw new BadRequestException('Invalid role. Must be an Organization role.');
    }

    // 2. Validation: Prevent Demoting the Last Owner
    // If we are changing an Owner to something else, check if they are the LAST one.
    const memberToUpdate = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { role: true },
    });

    if (!memberToUpdate) throw new NotFoundException('Member not found');

    if (memberToUpdate.role.slug === 'owner' && newRole.slug !== 'owner') {
      await this.assertNotLastOrgOwner(organizationId, memberId);
    }

    // 3. Execute Update
    return this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { roleId },
      include: { role: true },
    });
  }

  /**
   * Fire an employee.
   * This removes them from the Organization AND all Workspaces (Cascading delete).
   */
  async remove(params: {
    actorId: string;
    organizationId: string;
    memberId: string;
  }) {
    const { actorId, organizationId, memberId } = params;

    // 1. Prevent Suicide (Optional, but good UX)
    // Most apps force you to leave via a separate "Leave Org" button, 
    // rather than "Removing yourself" from the list.
    if (actorId === memberId) {
      throw new BadRequestException('You cannot remove yourself. Use "Leave Organization" instead.');
    }

    // 2. Find Member
    const memberToRemove = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { role: true },
    });

    if (!memberToRemove || memberToRemove.organizationId !== organizationId) {
      throw new NotFoundException('Member not found');
    }

    // 3. Prevent Removing Last Owner
    if (memberToRemove.role.slug === 'owner') {
      await this.assertNotLastOrgOwner(organizationId, memberId);
    }

    // 4. Execute (Cascade Delete)
    await this.prisma.organizationMember.delete({
      where: { id: memberId },
    });

    return { success: true };
  }

  /**
 * Allows a user to voluntarily leave the organization.
 */
async leave(userId: string, organizationId: string) {
  // 1. Find the Member Record for this User
  const member = await this.prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
    include: { role: true },
  });

  if (!member) {
    throw new NotFoundException('You are not a member of this organization');
  }

  // 2. Safety Check: Are they the last captain?
  if (member.role.slug === 'owner') {
    await this.assertNotLastOrgOwner(organizationId, member.id);
  }

  // 3. Execution (Cascading Delete)
  // This removes them from the Org AND all Workspaces automatically
  // (Assuming onDelete: Cascade in schema)
  await this.prisma.organizationMember.delete({
    where: { id: member.id },
  });

  return { success: true };
}

  // --- HELPERS ---

  private async assertNotLastOrgOwner(organizationId: string, memberIdToRemove: string) {
    const ownerRole = await this.prisma.role.findFirst({
      where: { scope: RoleScope.ORGANIZATION, slug: 'owner' },
    });

    if (!ownerRole) return;

    const remainingOwners = await this.prisma.organizationMember.count({
      where: {
        organizationId,
        roleId: ownerRole.id,
        NOT: { id: memberIdToRemove },
      },
    });

    if (remainingOwners === 0) {
      throw new BadRequestException(
        'Cannot remove or demote the last Organization Owner. Transfer ownership first.'
      );
    }
  }


  //@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) // Run once a day
  async cleanupAbandonedOrganizations() {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - 48); // 48 Hours ago

    // Find orgs that were created > 48 hours ago but never paid
    const abandoned = await this.prisma.organization.deleteMany({
      where: {
        status: 'PENDING_PAYMENT',
        createdAt: { lt: cutoffDate } // Older than 48 hours
      }
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
