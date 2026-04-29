import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
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

  async addMember(params: { workspaceId: string; dto: AddWorkspaceMemberDto }) {
    const { workspaceId, dto } = params;

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

    // 5) Create or Update workspace member (True Idempotency)
    const workspaceMember = await this.prisma.workspaceMember.upsert({
      where: {
        workspaceId_memberId: {
          workspaceId: workspace.id,
          memberId: targetOrgMember.id,
        },
      },
      update: {
        // If they already exist, optionally update their role,
        // or leave empty `{}` to do nothing.
        roleId: dto.roleId ?? null,
        isActive: true, // Reactivate them if they were previously soft-deleted!
        deletedAt: null,
      },
      create: {
        workspaceId: workspace.id,
        memberId: targetOrgMember.id,
        roleId: dto.roleId ?? null,
      },
      include: {
        member: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        role: true,
        workspace: { select: { id: true, name: true, slug: true } },
      },
    });

    return this.mapWorkspaceMemberResponse(workspaceMember);
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
    await this.prisma.workspaceMember.update({
      where: { id: workspaceMemberId },
      data: {
        isActive: false,
        deletedAt: new Date(),
      },
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
      select: {
        id: true,
        workspaceId: true,
        roleId: true,
        role: { select: { slug: true } },
        member: { select: { role: { select: { slug: true } } } },
      },
    });
    if (!wsMember || wsMember.workspaceId !== workspaceId) {
      throw new NotFoundException('Workspace member not found');
    }

    let newRoleSlug: string | null = null;
    if (dto.roleId) {
      await this.assertRoleIsWorkspaceScoped(
        dto.roleId,
        workspace.organizationId,
      );
      const newRole = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
        select: { slug: true },
      });
      newRoleSlug = newRole?.slug ?? null;
    }

    const isCurrentlyOwner =
      wsMember.role?.slug === 'ws-owner' ||
      (!wsMember.roleId && wsMember.member.role.slug === 'org-owner');

    const willRemainOwner =
      newRoleSlug === 'ws-owner' ||
      (!dto.roleId && wsMember.member.role.slug === 'org-owner');

    if (isCurrentlyOwner && !willRemainOwner) {
      await this.assertNotLastOwner(workspaceId, wsMember);
    }

    const updatedMember = await this.prisma.workspaceMember.update({
      where: { id: workspaceMemberId },
      data: { roleId: dto.roleId },
      include: {
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
          },
        },
        role: true,
      },
    });

    return this.mapWorkspaceMemberResponse(updatedMember);
  }

  /**
   * List members in a workspace with optional search.
   */
  async listMembers(params: {
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
      isActive: true,
      deletedAt: null,
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
      items: items.map(this.mapWorkspaceMemberResponse),
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
    // Offload the validation entirely to the database engine
    const role = await this.prisma.role.findFirst({
      where: {
        id: roleId,
        scope: 'WORKSPACE', // Must be workspace scoped
        OR: [
          { organizationId: null }, // Must be System (null)
          { organizationId: organizationId }, // OR belong to this Org
        ],
      },
      select: { id: true },
    });

    if (!role) {
      throw new BadRequestException(
        'Invalid workspace role. It must be a workspace-scoped role belonging to this organization.',
      );
    }
  }
  /**
   * Prevents removing a member if they are the LAST person with "Owner" privileges.
   * Checks both Explicit Roles (Workspace Override) and Implicit Roles (Org Owner).
   */
  private async assertNotLastOwner(workspaceId: string, memberToRemove: any) {
    const isExplicitOwner = memberToRemove.role?.slug === 'ws-owner';
    const isImplicitOwner =
      !memberToRemove.roleId && memberToRemove.member.role.slug === 'org-owner';

    if (!isExplicitOwner && !isImplicitOwner) return; // Not an owner, safe to remove

    // Single query to count ALL remaining owners (Explicit OR Implicit)
    const totalRemainingOwners = await this.prisma.workspaceMember.count({
      where: {
        workspaceId: workspaceId,
        NOT: { id: memberToRemove.id }, // Exclude the target
        deletedAt: null, // Ensure we only count active members
        OR: [
          { role: { slug: 'ws-owner' } }, // Explicit Workspace Owners
          {
            roleId: null, // Inheriting...
            member: { role: { slug: 'org-owner' } }, // ...the Org Owner role
          },
        ],
      },
    });

    if (totalRemainingOwners === 0) {
      throw new BadRequestException(
        'Cannot remove the last Owner. You must transfer ownership to another member first.',
      );
    }
  }

  private mapWorkspaceMemberResponse(wm: any) {
    return {
      id: wm.id,
      workspaceId: wm.workspaceId,
      role: wm.role
        ? {
            id: wm.role.id,
            name: wm.role.name,
            slug: wm.role.slug,
          }
        : null,
      user: {
        id: wm.member.user.id,
        firstName: wm.member.user.firstName,
        lastName: wm.member.user.lastName,
        email: wm.member.user.email,
        avatar: wm.member.user.avatar
          ? {
              url: wm.member.user.avatar.url,
              size: wm.member.user.avatar.size?.toString(),
            }
          : null,
      },
    };
  }
}
