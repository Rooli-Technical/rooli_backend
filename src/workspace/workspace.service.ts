import { PrismaService } from '@/prisma/prisma.service';
import { RoleScope } from '@generated/enums';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import slugify from 'slugify';
import { AddWorkspaceMemberDto } from './dtos/add-member.dto';
import { CreateWorkspaceDto } from './dtos/create-workspace.dto';
import { UpdateWorkspaceDto } from './dtos/update-workspace.dto';
import * as crypto from 'crypto';

@Injectable()
export class WorkspaceService {
  constructor(private prisma: PrismaService) {}

 async create(userId: string, orgId: string, dto: CreateWorkspaceDto) {
    // 1. Validate Billing Limits
    const { features } = await this.checkWorkspaceLimitAndGetFeatures(orgId);

    // 2. Generate Slug
    const slug = await this.generateUniqueSlug(orgId, dto.name);

    // 3. Prepare Feature-Gated Data
    const clientData = features['clientLabels']
      ? {
          agencyClientName: dto.clientName,
          agencyClientStatus: dto.clientStatus || 'Active',
          agencyClientColor: dto.clientColor || '#3b82f6',
          agencyClientContact: dto.clientContact,
        }
      : {};

    const defaultRole = await this.fetchDefaultWorkspaceRole();

    // 4. Transaction: Create & Link
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug: slug,
        organizationId: orgId,
        ...clientData,
        members: {
          create: { userId, roleId: defaultRole.id },
        },
      },
    });
  }

async findAll(orgId: string, userId: string) {
    // Optimization: Check Org Admin status once
    const orgMember = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      select: { role: { select: { name: true } } },
    });

    const isOrgAdmin = ['OWNER', 'ADMIN'].includes(orgMember?.role?.name || '');

    // Common Select object to ensure frontend gets consistent data
    // We explicitly select SocialProfile (Not Connection)
    const selectArgs = {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { members: true, posts: true } }, // Quick Stats
      
      socialProfiles: {
        select: {
          id: true,
          platform: true,
          username: true,
          picture: true,
          isActive: true
        },
        take: 5 // Don't fetch 100 profiles if they have them, just show previews
      }
    };

    if (isOrgAdmin) {
      return this.prisma.workspace.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        select: selectArgs,
      });
    }

    return this.prisma.workspace.findMany({
      where: {
        organizationId: orgId,
        members: { some: { userId } },
      },
      orderBy: { createdAt: 'desc' },
      select: selectArgs,
    });
  }

  async findOne(orgId: string, id: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id, organizationId: orgId },
      include: {
        // Full list for the detail view
        socialProfiles: {
           select: { id: true, platform: true, name: true, picture: true, isActive: true, followerCount: true } 
        },
        brandKit: true,
        _count: { select: { members: true, posts: true } },
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }


  async switchWorkspace(userId: string, workspaceId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { lastActiveWorkspaceId: workspaceId },
    });
  }

async update(workspaceId: string, dto: UpdateWorkspaceDto) {
  const workspace = await this.prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) throw new NotFoundException('Workspace not found');

  const data: any = {
    ...(dto.name !== undefined && { name: dto.name }),


    // map agency client fields correctly
    ...(dto.clientName !== undefined && { agencyClientName: dto.clientName }),
    ...(dto.clientStatus !== undefined && { agencyClientStatus: dto.clientStatus }),
    ...(dto.clientContact !== undefined && { agencyClientContact: dto.clientContact }),
    ...(dto.clientColor !== undefined && { agencyClientColor: dto.clientColor }),
  };

  return this.prisma.workspace.update({
    where: { id: workspaceId },
    data,
  });
}


  async delete(workspaceId: string) {
    return this.prisma.workspace.delete({
      where: { id: workspaceId },
    });
  }

  // --------------------------------------------------------
  // 3. MEMBER MANAGEMENT (Agency Features)
  // --------------------------------------------------------

async addMember(workspaceId: string, dto: AddWorkspaceMemberDto) {
    // 1.CHECK LIMITS FIRST (Billing Fix)
    await this.checkSeatLimit(workspaceId, dto.email);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new NotFoundException('User not found');

    // 2. Check Role Scope
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role || role.scope !== 'WORKSPACE') {
      throw new BadRequestException('Role must be Workspace-scoped');
    }

    // 3. Add Member (Use upsert or handle error for cleaner logs)
    try {
      return await this.prisma.workspaceMember.create({
        data: { workspaceId, userId: user.id, roleId: dto.roleId },
      });
    } catch (e: any) {
      if (e.code === 'P2002') throw new ConflictException('User already in workspace');
      throw e;
    }
  }


  async removeMember(workspaceId: string, userIdToRemove: string) {
    return this.prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: { workspaceId, userId: userIdToRemove },
      },
    });
  }

  // --------------------------------------------------------
  // 4. HELPERS
  // --------------------------------------------------------

  private async generateUniqueSlug(
    orgId: string,
    name: string,
  ): Promise<string> {
    const baseSlug = slugify(name, { lower: true, strict: true });
    let slug = baseSlug;
    let count = 1;

    while (true) {
      const existing = await this.prisma.workspace.findUnique({
        where: { organizationId_slug: { organizationId: orgId, slug } },
      });
      if (!existing) break;
      slug = `${baseSlug}-${count}`;
      count++;
    }
    return slug;
  }

  private async checkWorkspaceLimitAndGetFeatures(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        subscription: {
          include: { plan: true },
        },
        workspaces: { select: { id: true } },
      },
    });

    if (!org) throw new NotFoundException('Organization not found');

    // Handle "No Subscription" case (Fallback to Free/Default limits)
    const plan = org.subscription?.plan;
    const maxWorkspaces = plan?.maxWorkspaces || 1;
    const currentCount = org.workspaces.length;

    if (currentCount >= maxWorkspaces) {
      throw new ForbiddenException(
        `Workspace limit reached. Your plan allows ${maxWorkspaces} workspaces.`,
      );
    }

    return { features: (plan?.features as any) || {} };
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
      where: { organizationId: org.id },
    });

    // 4. THE VERDICT
    if (currentSeats + pendingInvites >= seatLimit) {
      throw new ForbiddenException(
        `Organization seat limit reached (${seatLimit} users). Upgrade your plan to invite new team members.`,
      );
    }
  }

  private async fetchDefaultWorkspaceRole() {
    // You should seed a default 'Editor' or 'Manager' role with scope WORKSPACE
    return this.prisma.role.findFirstOrThrow({
      where: { scope: RoleScope.WORKSPACE, isDefault: true },
    });
  }
}
