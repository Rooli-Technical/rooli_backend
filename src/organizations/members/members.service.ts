import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { UpdateMemberDto } from './dtos/update-member.dto';
import { PrismaService } from '@/prisma/prisma.service';
import { AddOrganizationMemberDto } from './dtos/add-organization-member.dto';

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganizationMembers(orgId: string, userId: string) {
    await this.verifyMembershipAccess(orgId, userId);

    const members = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
      },
      include: {
        role: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatar: true,
            lastActiveAt: true,
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    return members.map((m) => this.toSafeMember(m));
  }

  async addMember(
    organizationId: string,
    dto: AddOrganizationMemberDto,
    currentUserId: string,
  ) {
    // A. GUARD: Only Admin/Owner can add members
    const requester = await this.getMembership(organizationId, currentUserId);
    if (!requester || !this.isAdminOrOwner(requester)) {
      throw new ForbiddenException('Only Admins or Owners can add new members');
    }

    // B. SUBSCRIPTION CHECK: Plan Limits
    // We fetch the Org + Subscription + Plan in one go to be efficient
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        subscription: {
          select: {
            status: true,
            plan: { select: { maxTeamMembers: true } },
          },
        },
        _count: {
          select: { members: { where: { isActive: true } } },
        },
      },
    });

    if (!organization) throw new NotFoundException('Organization not found');

    const sub = organization.subscription;
    const currentCount = organization._count.members;

    // 1. Check if Subscription is Active
    if (!sub || sub.status !== 'active') {
      throw new BadRequestException(
        'Active subscription required to add members',
      );
    }

    // 2. Check Limits (Ignored if maxTeamMembers is 0 or -1 for "Unlimited")
    const limit = sub.plan.maxTeamMembers;
    if (limit && limit > 0 && currentCount >= limit) {
      throw new BadRequestException(
        `Plan limit reached. You can only have ${limit} active members.`,
      );
    }

    // C. VALIDATION: User Existence & Uniqueness
    const [targetUser, targetRole] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.userId } }),
      this.prisma.role.findUnique({ where: { id: dto.roleId } }),
    ]);

    if (!targetUser) throw new NotFoundException('User not found');
    if (!targetRole) throw new NotFoundException('Role not found');

    // Check if they are already a member (Active or Inactive)
    const existingMembership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: dto.userId,
        },
      },
    });

    // D. EXECUTION: Create or Reactivate
    if (existingMembership) {
      if (existingMembership.isActive) {
        throw new ConflictException('User is already an active member');
      } else {
        // Reactivate soft-deleted member
        const reactivated = await this.prisma.organizationMember.update({
          where: { id: existingMembership.id },
          data: {
            isActive: true,
            roleId: dto.roleId,
            permissions: dto.permissions ?? undefined,
          },
          include: { user: true, role: true },
        });
        return this.toSafeMember(reactivated);
      }
    }

    // Create fresh
    const newMember = await this.prisma.organizationMember.create({
      data: {
        organizationId,
        userId: dto.userId,
        roleId: dto.roleId,
        invitedBy: currentUserId,
        permissions: dto.permissions ?? undefined,
      },
      include: { user: true, role: true },
    });

    return this.toSafeMember(newMember);
  }

  async updateMember(
    orgId: string,
    memberId: string,
    updaterId: string,
    dto: UpdateMemberDto,
  ) {
    const updater = await this.getMembership(orgId, updaterId);

    const targetMember = await this.getMembership(orgId, undefined, memberId);
    if (!targetMember) throw new NotFoundException('Member not found');

    // Guard: Protect Owner
    if (this.isOwner(targetMember)) {
      throw new ForbiddenException('Cannot modify the Organization Owner');
    }

    //  Only Owners can promote others to Owner/Admin (Optional strictness)
    if (dto.roleId && !this.isOwner(updater)) {
      // Fetch the role they are trying to assign
      const newRole = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
      });
      if (newRole?.name === 'OWNER') {
        throw new ForbiddenException('Only Owners can transfer ownership');
      }
    }

    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: {
        roleId: dto.roleId,
        isActive: dto.isActive,
        permissions: dto.permissions,
      },
      include: { user: true, role: true },
    });

    return this.toSafeMember(updated);
  }

  async removeMember(orgId: string, memberId: string, removerId: string) {
    const remover = await this.getMembership(orgId, removerId);

    if (!remover || !this.isAdminOrOwner(remover)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const targetMember = await this.getMembership(orgId, undefined, memberId);
    if (!targetMember) throw new NotFoundException('Member not found');

    if (targetMember.userId === removerId) {
      throw new ConflictException(
        'You cannot remove yourself. Use "Leave Organization" instead.',
      );
    }

    if (this.isOwner(targetMember)) {
      throw new ForbiddenException('Cannot remove the Organization Owner');
    }

    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { isActive: false },
      include: { user: true, role: true },
    });

    return this.toSafeMember(updated);
  }

  async leaveOrganization(orgId: string, userId: string) {
    const membership = await this.getMembership(orgId, userId);
    if (!membership) throw new NotFoundException('Membership not found');

    if (this.isOwner(membership)) {
      throw new ForbiddenException(
        'Owner cannot leave. Please transfer ownership to another member first.',
      );
    }

    await this.prisma.organizationMember.update({
      where: { id: membership.id },
      data: { isActive: false },
    });

    return { success: true, message: 'Successfully left organization' };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private async verifyMembershipAccess(orgId: string, userId: string) {
    const count = await this.prisma.organizationMember.count({
      where: { organizationId: orgId, userId, isActive: true },
    });
    if (count === 0) throw new ForbiddenException('Access denied');
  }

  private async getMembership(
    orgId: string,
    userId?: string,
    memberId?: string,
  ) {
    return this.prisma.organizationMember.findFirst({
      where: {
        organizationId: orgId,
        isActive: true,
        ...(userId && { userId }),
        ...(memberId && { id: memberId }),
      },
      include: { user: true, role: true },
    });
  }

  // Flexible check to handle potential casing issues or different schema names
  private isOwner(member: { role?: { name: string } }) {
    return member.role?.name?.toUpperCase() === 'OWNER';
  }

  private isAdminOrOwner(member: { role?: { name: string } }) {
    const r = member.role?.name?.toUpperCase();
    return r === 'ADMIN' || r === 'OWNER';
  }

  private toSafeMember(member: any) {
    return {
      id: member.id,
      role: member.role ? { id: member.role.id, name: member.role.name } : null,
      isActive: member.isActive,
      permissions: member.permissions,
      joinedAt: member.joinedAt,
      lastActiveAt: member.lastActiveAt,
      user: member.user
        ? {
            id: member.user.id,
            email: member.user.email,
            firstName: member.user.firstName,
            lastName: member.user.lastName,
            avatar: member.user.avatar,
          }
        : null,
    };
  }
}
