import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
     // 1. Allow endpoints marked as Public
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 🚨 NEW: Check if this route allows suspended organizations
    const allowSuspended = this.reflector.getAllAndOverride<boolean>(
      'allowSuspended',
      [context.getHandler(), context.getClass()]
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.userId) return false;

    const params = request.params;
    const workspaceId = params.workspaceId || params.wsId;
    const organizationId = params.organizationId || params.orgId;

    // ====================================================
    // 1. WORKSPACE CONTEXT
    // ====================================================
    if (workspaceId) {
      const wsMember = await this.prisma.workspaceMember.findFirst({
        where: {
          workspaceId: workspaceId,
          member: { userId: user.userId },
        },
        include: {
          role: { // The explicit Workspace Role
            include: { permissions: { include: { permission: true } } },
          },
          member: {
            include: { 
              organization: { select: { status: true, id: true } },
              role: { // 👈 FIX: Must fetch the Org Role for inheritance!
                include: { permissions: { include: { permission: true } } }
              }
            },
          },
        },
      });

      if (!wsMember) {
        throw new ForbiddenException('You do not have access to this workspace');
      }

      // Step 2: Check Suspension
      // 🚨 THE FIX: Only throw if the route doesn't allow suspended orgs!
      if (wsMember.member.organization.status === 'SUSPENDED' && !allowSuspended) {
        throw new ForbiddenException('Organization is suspended');
      }

      // Step 3: Fire-and-forget update
      await this.updateLastActive(user.userId, workspaceId).catch(() => {});

      // 🚨 CRITICAL FIX: Use workspace role if it exists, otherwise fallback to org role
      const activeRole = wsMember.role || wsMember.member.role;

      // Step 4: Attach Context
      request.currentContext = 'WORKSPACE';
      request.orgId = wsMember.member.organization.id;
      request.workspaceId = workspaceId;
      request.orgMember = wsMember.member;
      request.currentRole = activeRole;

      // Optimization: Extract permissions names for easier checking
      request.permissions = activeRole.permissions.map(
        (p) => `${p.permission.resource.toLowerCase()}.${p.permission.action.toLowerCase()}`
      );

      return true;
    }

    // ====================================================
    // 2. ORGANIZATION CONTEXT (Settings/Billing)
    // ====================================================
    if (organizationId) {
      const orgMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: user.userId },
        },
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
          organization: { select: { status: true } },
        },
      });

      if (!orgMember) throw new ForbiddenException('Not a member of this organization');

     if (orgMember.organization.status === 'SUSPENDED' && !allowSuspended) {
        throw new ForbiddenException('Organization is suspended');
      }
      
      request.currentContext = 'ORGANIZATION';
      request.orgId = organizationId;
      request.orgMember = orgMember;
      request.currentRole = orgMember.role;
      request.permissions = orgMember.role.permissions.map(
        (p) => `${p.permission.resource.toLowerCase()}.${p.permission.action.toLowerCase()}`
      );
      
      return true;
    }

    return true;
  }

  private async updateLastActive(userId: string, workspaceId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastActiveWorkspaceId: workspaceId },
    });
  }
}