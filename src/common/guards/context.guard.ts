import { PrismaService } from '@/prisma/prisma.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
          member: {
            include: { organization: { select: { status: true, id: true } } },
          },
        },
      });

      if (!wsMember) {
        throw new ForbiddenException(
          'You do not have access to this workspace',
        );
      }

      // Step 2: Check Suspension
      if (wsMember.member.organization.status === 'SUSPENDED') {
        throw new ForbiddenException('Organization is suspended');
      }

      // Step 3: Fire-and-forget update (Don't await!)
      this.updateLastActive(user.userId, workspaceId);

      //Step 4: Attach Context
      request.currentContext = 'WORKSPACE';
      request.orgId = wsMember.member.organization.id;
      request.workspaceId = workspaceId;
      request.orgMember = wsMember.member;

      // CRITICAL FIX: Always use the Workspace Role
      request.currentRole = wsMember.role;

      // Optimization: Extract permissions names for easier checking
     request.permissions = wsMember.role.permissions.map(
  (p) => `${p.permission.resource}.${p.permission.action}`
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

      if (!orgMember)
        throw new ForbiddenException('Not a member of this organization');

      if (orgMember.organization.status === 'SUSPENDED') {
        throw new ForbiddenException('Organization is suspended');
      }

      request.currentContext = 'ORGANIZATION';
      request.orgId = organizationId;
      request.orgMember = orgMember;
      request.currentRole = orgMember.role;
      request.permissions = orgMember.role.permissions.map(
  (p) => `${p.permission.resource}.${p.permission.action}`
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
