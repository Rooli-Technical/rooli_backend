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

    await this.logAuditEvent(orgId, updaterId, 'member_updated', {
      updatedMemberId: memberId,
      updates: dto,
    });

    return this.toSafeMember(updated);
  }

  //add admin and org owner guard
   async addMember(
    organizationId: string,
    dto: AddOrganizationMemberDto,
    currentUserId: string,
  ) {
    // Verify org exists
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { members: true },
    });


    if (!organization) throw new NotFoundException('Organization not found');

    // Enforce member limit
    const activeMemberCount = await this.prisma.organizationMember.count({
      where: { organizationId, isActive: true },
    });

    if (
      organization.maxMembers !== null &&
      activeMemberCount >= organization.maxMembers
    ) {
      throw new BadRequestException('Member limit reached for this plan');
    }

    // Prevent duplicates
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

    // Validate user & role
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.userId } }),
      this.prisma.role.findUnique({ where: { id: dto.roleId } }),
    ]);

    if (!user) throw new NotFoundException('User not found');
    if (!role) throw new NotFoundException('Role not found');

    // Create membership
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

    await this.logAuditEvent(orgId, removerId, 'member_removed', {
      removedMemberId: memberId,
      removedMemberEmail: updatedMember.user?.email,
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

    await this.logAuditEvent(orgId, userId, 'member_left', {
      memberId: membership.id,
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


  private async logAuditEvent(
    orgId: string,
    userId: string,
    action: string,
    details: any,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        userId: userId,
        action: action,
        resourceType: 'member',
        details: details,
      },
    });
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
