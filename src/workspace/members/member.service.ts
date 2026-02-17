import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import { RoleScope } from '@generated/enums';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UpdateWorkspaceMemberRoleDto } from './dtos/update-member-role.dto';
import { AddWorkspaceMemberDto } from './dtos/add-workspace-member.dto';
import { ListMembersQueryDto } from './dtos/list-members.dto';

@Injectable()
export class WorkspaceMemberService {
  constructor(private readonly prisma: PrismaService) {}

  async addMember(params: {
    userId: string;
    workspaceId: string;
    dto: AddWorkspaceMemberDto;
  }) {
    const { userId, workspaceId, dto } = params;

    // 1) Load workspace + orgId
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // 3) Target org member must be in same org
    const targetOrgMember = await this.prisma.organizationMember.findUnique({
      where: { id: dto.organizationMemberId },
      select: { id: true, organizationId: true, userId: true },
    });
    if (!targetOrgMember)
      throw new NotFoundException('Organization member not found');

    if (targetOrgMember.organizationId !== workspace.organizationId) {
      throw new ForbiddenException(
        'Member does not belong to this organization',
      );
    }

    // 4) Validate workspace role override if provided
    if (dto.roleId) {
      await this.assertRoleIsWorkspaceScoped(
        dto.roleId,
        workspace.organizationId,
      );
    }

    // 5) Create workspace member (idempotent-ish)
    try {
      return await this.prisma.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          memberId: targetOrgMember.id,
          roleId: dto.roleId ?? null,
        },
        include: {
          member: {
            include: {
              user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          },
          role: true,
          workspace: { select: { id: true, name: true, slug: true } },
        },
      });
    } catch (e: any) {
      if (e.code === 'P2002') {
        throw new BadRequestException('User is already in this workspace');
      }
      throw e;
    }
  }

  async removeMember(params: {
    workspaceId: string;
    workspaceMemberId: string;
    preventRemovingLastOwner?: boolean;
  }) {
    const { workspaceId, workspaceMemberId } = params;
    const prevent = params.preventRemovingLastOwner ?? true;

    // 1. Find the TARGET (The person getting fired)
    // We still need to query this because we need their ROLES to do the check.
    const wsMemberToRemove = await this.prisma.workspaceMember.findUnique({
      where: { id: workspaceMemberId },
      include: {
        role: true, // Explicit Role
        member: { include: { role: true } }, // Implicit Org Role
      },
    });

    // 2. Validation: Does the target actually exist in this workspace?
    if (!wsMemberToRemove || wsMemberToRemove.workspaceId !== workspaceId) {
      throw new NotFoundException('Member not found in this workspace');
    }

    // 3. The "Last Owner" Business Logic
    if (prevent) {
      await this.assertNotLastOwner(workspaceId, wsMemberToRemove);
    }

    // 4. Execution
    await this.prisma.workspaceMember.delete({
      where: { id: workspaceMemberId },
    });

    return { success: true };
  }

  /**
   * Set or clear workspace role override.
   * roleId=null means remove override and fallback to org role.
   */
  async updateMemberRole(params: {
    workspaceId: string;
    workspaceMemberId: string;
    dto: UpdateWorkspaceMemberRoleDto;
  }) {
    const { workspaceId, workspaceMemberId, dto } = params;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const wsMember = await this.prisma.workspaceMember.findUnique({
      where: { id: workspaceMemberId },
      select: { id: true, workspaceId: true },
    });
    if (!wsMember || wsMember.workspaceId !== workspaceId) {
      throw new NotFoundException('Workspace member not found');
    }

    if (dto.roleId) {
      await this.assertRoleIsWorkspaceScoped(
        dto.roleId,
        workspace.organizationId,
      );
    }

    return this.prisma.workspaceMember.update({
      where: { id: workspaceMemberId },
      data: { roleId: dto.roleId },
      include: {
        member: {
          include: { user: { select: { id: true, email: true, firstName: true, lastName: true, avatar: true } } },
        },
        role: true,
      },
    });
  }

  /**
   * List members in a workspace with optional search.
   */
  async listMembers(params: {
    userId: string;
    workspaceId: string;
    query?: ListMembersQueryDto;
  }) {
    const { workspaceId, query } = params;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const take = Math.min(query?.limit ?? 20, 100);
    const skip = ((query?.page ?? 1) - 1) * take;

    const search = query?.search?.trim();
    const where: Prisma.WorkspaceMemberWhereInput = {
      workspaceId,
      ...(search
        ? {
            OR: [
              {
                member: {
                  user: { email: { contains: search, mode: 'insensitive' } },
                },
              },
              {
                member: {
                  user: {
                    firstName: { contains: search, mode: 'insensitive' },
                  },
                },
              },
              {
                member: {
                  user: { lastName: { contains: search, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.workspaceMember.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'desc' },
        include: {
          role: true,
          member: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  avatar: true,
                },
              },
              role: true,
            },
          },
        },
      }),
      this.prisma.workspaceMember.count({ where }),
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



  // -------------------------
  // Helpers
  // -------------------------

  /**
   * Ensures the role used as a workspace override is valid.
   * We allow:
   * - system WORKSPACE roles (organizationId null)
   * - org-specific WORKSPACE roles (organizationId = current org)
   */
  private async assertRoleIsWorkspaceScoped(
    roleId: string,
    organizationId: string,
  ) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, scope: true, organizationId: true },
    });
    if (!role) throw new BadRequestException('Invalid role');

    if (role.scope !== RoleScope.WORKSPACE) {
      throw new BadRequestException('Role is not a workspace role');
    }

    // If role is org-scoped, ensure it matches this org
    if (role.organizationId && role.organizationId !== organizationId) {
      throw new ForbiddenException('Role belongs to another organization');
    }
  }


  /**
   * Prevents removing a member if they are the LAST person with "Owner" privileges.
   * Checks both Explicit Roles (Workspace Override) and Implicit Roles (Org Owner).
   */
  private async assertNotLastOwner(
    workspaceId: string,
    memberToRemove: any,
  ) {
    // A. Check if the person we are removing is even an owner
    const isExplicitOwner = memberToRemove.role?.slug === 'owner';
    // They are an implicit owner if they have NO workspace role override,
    // but their Org role is 'owner'.
    const isImplicitOwner =
      !memberToRemove.roleId && memberToRemove.member.role.slug === 'owner';

    // If they aren't an owner, we don't care. Safe to delete.
    if (!isExplicitOwner && !isImplicitOwner) {
      return;
    }

    // B. If we are here, we are removing a "Boss".
    // We must verify at least ONE other Boss remains.

    // Count 1: Other Explicit Workspace Owners
    const otherExplicitOwners = await this.prisma.workspaceMember.count({
      where: {
        workspaceId: workspaceId,
        NOT: { id: memberToRemove.id }, // Exclude our target
        role: { slug: 'owner' }, // Look for 'owner' slug
      },
    });

    // Count 2: Other Implicit Owners
    // (Org Owners who are in this workspace but haven't been given a specific role override)
    const otherImplicitOwners = await this.prisma.workspaceMember.count({
      where: {
        workspaceId: workspaceId,
        NOT: { id: memberToRemove.id }, // Exclude our target
        roleId: null, // Must inherit
        member: { role: { slug: 'owner' } }, // Inherits 'owner'
      },
    });

    const totalRemainingOwners = otherExplicitOwners + otherImplicitOwners;

    if (totalRemainingOwners === 0) {
      throw new BadRequestException(
        'Cannot remove the last Owner. You must transfer ownership to another member first.',
      );
    }
  }
}
