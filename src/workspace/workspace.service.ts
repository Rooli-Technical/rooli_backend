import { PrismaService } from '@/prisma/prisma.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateWorkspaceDto } from './dtos/create-workspace.dto';
import { UpdateWorkspaceDto } from './dtos/update-workspace.dto';
import { Workspace, Prisma } from '@generated/client';
import { ListWorkspacesQueryDto } from './dtos/list-workspaces.dto';
import { AuthService } from '@/auth/auth.service';

@Injectable()
export class WorkspaceService {
  constructor(private prisma: PrismaService, private authService: AuthService) {}

  async createWorkspace(
    creatorUserId: string,
    organizationId: string,
    dto: CreateWorkspaceDto,
  ): Promise<Workspace> {
    // Enforce plan limit BEFORE transaction
    await this.checkWorkspaceLimitAndGetFeatures(organizationId);

    const slug = this.normalizeSlug(dto.slug ?? dto.name);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1) Ensure creator is org member
        const orgMember = await tx.organizationMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organizationId,
              userId: creatorUserId,
            },
          },
          select: { id: true },
        });

        if (!orgMember) {
          throw new ForbiddenException('Not a member of this organization.');
        }


        // 2) Create workspace
        const workspace = await tx.workspace.create({
          data: {
            organizationId: organizationId,
            name: dto.name.trim(),
            slug,
            timezone: dto.timezone ?? 'UTC',

            agencyClientName: dto.agencyClientName ?? null,
            agencyClientStatus: dto.agencyClientStatus ?? null,
            agencyClientContact: dto.agencyClientContact ?? null,
            agencyClientColor: dto.agencyClientColor ?? null,
          },
        });

        // 3) Add creator as workspace member
        // Fetch OWNER role id (org override if exists, else system)
        const ownerRoleId = await this.getRoleIdOrThrow(tx, {
          scope: 'WORKSPACE',
          slug: 'owner',
          organizationId: organizationId,
        });

        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            memberId: orgMember.id,
            roleId: ownerRoleId,
          },
        });

        return workspace;
      });
    } catch (e: any) {
      if (this.isPrismaUniqueError(e)) {
        throw new BadRequestException(
          `Workspace slug "${slug}" is already taken in this organization.`,
        );
      }
      throw e;
    }
  }

  /**
   * List workspaces within an org the user belongs to.
   *
   */
  async listOrganizationWorkspaces(
    userId: string,
    organizationId: string,
    query?: ListWorkspacesQueryDto,
  ) {
    const member = await this.getOrgMemberOrThrow({ organizationId, userId });

    // Check if Admin/Owner
    const isOrgAdmin = ['OWNER', 'ADMIN'].includes(member.role?.name);

    const limit = Math.min(query?.limit ?? 20, 100);
    const page = Math.max(query?.page ?? 1, 1);

    const take = limit;
    const skip = (page - 1) * limit;

    const orderBy = query?.orderBy ?? 'updatedAt';
    const orderDir = query?.orderDir ?? 'desc';

    const search = query?.search?.trim();

    const where: Prisma.WorkspaceWhereInput = {
      organizationId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
              { agencyClientName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // 3. APPLY RESTRICTION
    if (!isOrgAdmin) {
      where.members = {
        some: {
          memberId: member.id, // Only show workspaces where I am a member
        },
      };
    }

    // Use transaction so count + data are consistent
    const [total, data] = await this.prisma.$transaction([
      this.prisma.workspace.count({ where }),
      this.prisma.workspace.findMany({
        where,
        take,
        skip,
        orderBy: { [orderBy]: orderDir },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a workspace by id with org scoping.
   * Requires org membership; optionally require workspace membership.
   */
  async getWorkspace(orgId: string, workspaceId: string) {

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId, organizationId: orgId },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        members: {
          include: {
            role: true, 
            member: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    avatar: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found.');

    return workspace;
  }

  /**
   * Update workspace. Minimal rule: user must belong to org.
   * In real life you should require a permission like WORKSPACE:UPDATE.
   */
  async updateWorkspace(
    workspaceId: string,
    dto: UpdateWorkspaceDto
  ): Promise<Workspace> {

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');


    const data: Prisma.WorkspaceUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.slug !== undefined) data.slug = this.normalizeSlug(dto.slug);

    // agency fields
    if (dto.agencyClientName !== undefined)
      data.agencyClientName = dto.agencyClientName;
    if (dto.agencyClientStatus !== undefined)
      data.agencyClientStatus = dto.agencyClientStatus;
    if (dto.agencyClientContact !== undefined)
      data.agencyClientContact = dto.agencyClientContact;
    if (dto.agencyClientColor !== undefined)
      data.agencyClientColor = dto.agencyClientColor;

    try {
      return await this.prisma.workspace.update({
        where: { id: workspaceId },
        data,
      });
    } catch (e: any) {
      if (this.isPrismaUniqueError(e)) {
        throw new BadRequestException(
          `Workspace slug "${data.slug}" is already taken in this organization.`,
        );
      }
      throw e;
    }
  }

  /**
   * Delete workspace.
   * If you want soft-delete, add deletedAt and update instead.
   */
  async deleteWorkspace(workspaceId: string ) {

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found.');


    // If posts/media/etc have onDelete: Cascade, this is fine.
    // If not, you’ll get FK errors, so decide your delete strategy.
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
    return { deleted: true };
  }

async switchWorkspace(userId: string, targetWorkspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: targetWorkspaceId },
      select: { 
        id: true, 
        organizationId: true,
        organization: {
          select: { status: true }
        }
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.organization.status === 'SUSPENDED') {
      throw new ForbiddenException('Organization is suspended');
    }

    // 3. Update "Sticky Session" (Last Active Workspace)
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { lastActiveWorkspaceId: targetWorkspaceId },
      select: { id: true, email: true, refreshTokenVersion: true }
    });

    // 4. Generate New Tokens with the updated context
    // This allows the frontend to immediately start making requests with the new workspaceId
    const tokens = await this.authService.generateTokens(
      user.id,
      user.email,
      workspace.organizationId,
      targetWorkspaceId,
      user.refreshTokenVersion,
    );

    // 5. Update the refresh token in the DB (standard auth flow)
    await this.authService.updateRefreshToken(user.id, tokens.refreshToken);

    return {
      message: 'Workspace switched successfully',
      activeWorkspaceId: targetWorkspaceId,
      activeOrgId: workspace.organizationId,
      ...tokens,
    };
  }



  private normalizeSlug(input: string) {
    const s = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    if (!s) throw new BadRequestException('Slug cannot be empty.');
    if (s.length > 64) throw new BadRequestException('Slug too long (max 64).');
    return s;
  }

  private async getOrgMemberOrThrow(params: {
    organizationId: string;
    userId: string;
  }) {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: params.organizationId,
          userId: params.userId,
        },
      },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        role: true,
      },
    });

    if (!member)
      throw new ForbiddenException('Not a member of this organization.');
    if ((member as any).deletedAt)
      throw new ForbiddenException('Membership is inactive.');
    return member;
  }

  private isPrismaUniqueError(e: any) {
    return e?.code === 'P2002';
  }

  // --------------------------------------------------------
  // 4. HELPERS
  // --------------------------------------------------------

  private async checkWorkspaceLimitAndGetFeatures(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        subscription: {
          include: { plan: true },
        },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');

    // 1. Check Subscription Status
    const sub = org.subscription;
    const isActive = sub && ['ACTIVE'].includes(sub.status);

    // 2. Determine Effective Plan (Fallback to Free/Default limits if inactive)
    const plan = isActive ? sub.plan : null;

    // 3. Set Limits (Default to 1 if no active plan)
    // This ensures even free users (who might not have a sub row) are limited to 1.
    const maxWorkspaces = plan?.maxWorkspaces ?? 1;

    // 4. Count & Enforce
    const currentCount = await this.prisma.workspace.count({
      where: { organizationId: orgId },
    });

    if (currentCount >= maxWorkspaces) {
      throw new ForbiddenException(
        `Workspace limit reached. Your plan allows ${maxWorkspaces} workspaces.`,
      );
    }

    return { features: (plan?.features as any) ?? {} };
  }

  private async checkSeatLimit(workspaceId: string, email: string) {
    const lowerEmail = email.toLowerCase();

    // 1. GET CONTEXT (Org & Plan)
    // We fetch the Organization through the Workspace
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        organization: {
          include: {
            subscription: { include: { plan: true } },
          },
        },
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');
    const org = workspace.organization;

    // 2. CHECK "ALREADY PAID" STATUS (The Free Pass)
    // If this user is ALREADY a member of the Organization (in any workspace),
    // they have already consumed a seat. We do NOT block them.
    const existingOrgMember = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: org.id,
        user: { email: lowerEmail },
      },
    });

    if (existingOrgMember) {
      return; // ✅ PASS: They are an existing, paid seat.
    }

    // 3. CHECK "NEW SEAT" AVAILABILITY
    // If we reach here, this is a BRAND NEW user for the Organization.
    const seatLimit = org.subscription?.plan?.maxTeamMembers || 1; // Default to 1 (Solo)

    // A. Count Active Members (Seats taken)
    const currentSeats = await this.prisma.organizationMember.count({
      where: { organizationId: org.id },
    });

    // B. Count Pending Invites (Seats reserved)
    // We must count these, otherwise users could blast 100 invites on a 3-user plan
    const pendingInvites = await this.prisma.invitation.count({
      where: { organizationId: org.id, status: 'PENDING' },
    });

    // 4. THE VERDICT
    if (currentSeats + pendingInvites >= seatLimit) {
      throw new ForbiddenException(
        `Organization seat limit reached (${seatLimit} users). Upgrade your plan to invite new team members.`,
      );
    }
  }

  private async getRoleIdOrThrow(
    tx: Prisma.TransactionClient,
    params: {
      scope: 'WORKSPACE' | 'ORGANIZATION';
      slug: string;
      organizationId?: string;
    },
  ): Promise<string> {
    const { scope, slug, organizationId } = params;

    // 1) org-specific override
    if (organizationId) {
      const custom = await tx.role.findFirst({
        where: { scope, slug, organizationId },
        select: { id: true },
      });
      if (custom) return custom.id;
    }

    // 2) system fallback
    const system = await tx.role.findFirst({
      where: { scope, slug, organizationId: null, isSystem: true },
      select: { id: true },
    });
    if (system) return system.id;

    throw new Error(`Role not found: scope=${scope}, slug=${slug}`);
  }
}
