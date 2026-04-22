import { PrismaService } from '@/prisma/prisma.service';
import { RoleScope } from '@generated/enums';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListMembersQueryDto } from '../dtos/list-members.dto';
import { Prisma } from '@generated/client';

@Injectable()
export class OrganizationMemberService {
  constructor(private readonly prisma: PrismaService) {}

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
          role: {
            select: {
              id: true,
              name: true,
              slug: true,
              scope: true,
            },
          }, 
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

  async getOneOrganizationMember(memberId: string, organizationId: string) {
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId, organizationId },
      include: {
        role: {
          select: {
            id: true,
            name: true,
            slug: true,
            scope: true,
          },
        },
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
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    return member;
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
      throw new BadRequestException(
        'Invalid role. Must be an Organization role.',
      );
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

    const memberToRemove = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { role: true },
    });

    if (!memberToRemove || memberToRemove.organizationId !== organizationId) {
      throw new NotFoundException('Member not found');
    }

    // 2. Prevent Suicide (Apples to Apples comparison)
    // 🚨 FIX: Compare actorId to the actual userId of the member record
    if (actorId === memberToRemove.userId) {
      throw new BadRequestException(
        'You cannot remove yourself. Use "Leave Organization" instead.',
      );
    }

    // 3. Prevent Removing Last Owner
    if (memberToRemove.role.slug === 'org-owner') {
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
    if (member.role.slug === 'org-owner') {
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

  private async assertNotLastOrgOwner(
    organizationId: string,
    memberIdToRemove: string,
  ) {
    const ownerRole = await this.prisma.role.findFirst({
      where: { scope: RoleScope.ORGANIZATION, slug: 'org-owner' },
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
        'Cannot remove or demote the last Organization Owner. Transfer ownership first.',
      );
    }
  }

  // ---------------------------------------------------------
  // REACTIVATE A SUSPENDED TEAM MEMBER
  // ---------------------------------------------------------
  async reactivateTeamMember(organizationId: string, memberId: string) {
    // 1. Fetch the Organization, Plan Limits, and Active User Count
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: {
          include: { plan: true },
        },
        _count: {
          select: {
            members: { where: { isActive: true } }, // Only count currently active people
          },
        },
      },
    });

    const sub = org?.subscription;
    if (!sub || !sub.isActive) {
      throw new BadRequestException('You need an active premium plan to manage team members.');
    }

    // 2. The Logic Check: Do they have an empty seat?
    const maxAllowedUsers = sub.plan.maxUsers;
    const currentlyActiveUsers = org._count.members;

    if (currentlyActiveUsers >= maxAllowedUsers) {
      throw new ForbiddenException(
        `You have reached your limit of ${maxAllowedUsers} active users. Please delete an active user or upgrade your plan before reactivating this member.`
      );
    }

    // 3. The Execution: Welcome back!
    await this.prisma.organizationMember.update({
      where: { 
        id: memberId, 
        organizationId: organizationId 
      },
      data: { isActive: true },
    });

    return { message: 'Team member successfully reactivated.' };
  }
}
