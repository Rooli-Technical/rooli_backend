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

    const members = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
      },
      include: {
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

  async updateMember(
    orgId: string,
    memberId: string,
    updaterId: string,
    dto: UpdateMemberDto,
  ) {
    const updaterMembership = await this.getMembership(orgId, updaterId);
    if (!updaterMembership || !this.isAdminOrOwner(updaterMembership)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const targetMember = await this.getMembership(orgId, undefined, memberId);
    if (!targetMember) {
      throw new NotFoundException('Member not found');
    }

    if (this.isOwner(targetMember)) {
      throw new ForbiddenException('Cannot modify organization owner');
    }

    if (dto.roleId && !this.isOwner(updaterMembership)) {
      throw new ForbiddenException('Only owners can assign owner role');
    }

    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: {
        roleId: dto.roleId,
        isActive: dto.isActive,
        permissions: dto.permissions,
      },
      include: { user: true },
    });

    return this.toSafeMember(updated);
  }

  //add admin and org owner guard
 async addMember(
  organizationId: string,
  dto: AddOrganizationMemberDto,
  currentUserId: string,
) {
  // 1. Verify organization exists
  const organization = await this.prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });

  if (!organization) {
    throw new NotFoundException('Organization not found');
  }

  // 2. Get active subscription + plan limit
  const subscription = await this.prisma.subscription.findUnique({
    where: { organizationId },
    select: {
      status: true,
      plan: {
        select: {
          maxTeamMembers: true,
        },
      },
    },
  });

  // No active subscription = no adding members
  if (!subscription || subscription.status !== 'active') {
    throw new BadRequestException(
      'Your subscription does not allow adding team members',
    );
  }

  // 3. Count active members
  const activeMemberCount = await this.prisma.organizationMember.count({
    where: {
      organizationId,
      isActive: true,
    },
  });

  if (activeMemberCount >= subscription.plan.maxTeamMembers) {
    throw new BadRequestException(
      'Member limit reached for your current plan',
    );
  }

  // 4. Prevent duplicates
  const existingMember = await this.prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId: dto.userId,
      },
    },
  });

  if (existingMember) {
    throw new BadRequestException('User is already a member');
  }

  // 5. Validate user & role
  const [user, role] = await Promise.all([
    this.prisma.user.findUnique({ where: { id: dto.userId } }),
    this.prisma.role.findUnique({ where: { id: dto.roleId } }),
  ]);

  if (!user) throw new NotFoundException('User not found');
  if (!role) throw new NotFoundException('Role not found');

  // 6. Create membership
  return this.prisma.organizationMember.create({
    data: {
      organizationId,
      userId: dto.userId,
      roleId: dto.roleId,
      invitedBy: currentUserId,
      permissions: dto.permissions ?? null,
    },
    include: {
      user: true,
      role: true,
    },
  });
}


  async removeMember(orgId: string, memberId: string, removerId: string) {
    const removerMembership = await this.getMembership(orgId, removerId);
    if (!removerMembership || !this.isAdminOrOwner(removerMembership)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const targetMember = await this.getMembership(orgId, undefined, memberId);
    if (!targetMember) {
      throw new NotFoundException('Member not found');
    }

    if (targetMember.userId === removerId) {
      throw new ConflictException('Cannot remove yourself from organization');
    }

    if (this.isOwner(targetMember)) {
      throw new ForbiddenException('Cannot remove organization owner');
    }

    const updatedMember = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { isActive: false },
      include: { user: true },
    });

    return this.toSafeMember(updatedMember);
  }

  async leaveOrganization(orgId: string, userId: string) {
    const membership = await this.getMembership(orgId, userId);
    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    if (this.isOwner(membership)) {
      throw new ForbiddenException(
        'Organization owner cannot leave. Transfer ownership first.',
      );
    }

    await this.prisma.organizationMember.update({
      where: { id: membership.id },
      data: { isActive: false },
    });

    return { success: true, message: 'Successfully left organization' };
  }

  // --- Helpers ---

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

  private isOwner(member: { role: { name: string } }) {
    return member.role?.name === 'OWNER';
  }

  private isAdminOrOwner(member: { role: { name: string } }) {
    return member.role?.name === 'ADMIN' || member.role?.name === 'OWNER';
  }



  private toSafeMember(member: any) {
    return {
      id: member.id,
      role: member.role,
      isActive: member.isActive,
      permissions: member.permissions,
      joinedAt: member.joinedAt,
      lastActiveAt: member.lastActiveAt,
      user: member.user && {
        id: member.user.id,
        email: member.user.email,
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        avatar: member.user.avatar,
      },
    };
  }
}
