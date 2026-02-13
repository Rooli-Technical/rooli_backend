import { PrismaService } from '@/prisma/prisma.service';
import { 
  Injectable, 
  CanActivate, 
  ExecutionContext, 
  ForbiddenException 
} from '@nestjs/common';

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // 1. Safety Check: AuthGuard must run first
    if (!user || !user.userId) return true;

    const params = request.params;
    const workspaceId = params.workspaceId || params.wsId;
    const organizationId = params.organizationId || params.orgId;

    // ====================================================
    // SCENARIO A: User is accessing a WORKSPACE
    // ====================================================
   if (workspaceId) {
      // 1. Path: User -> OrganizationMember -> WorkspaceMember
      const wsMember = await this.prisma.workspaceMember.findFirst({
        where: {
          workspaceId,
          member: { userId: user.userId }, // Nested filter via the join table
        },
        include: { 
          role: { include: { permissions: { include: { permission: true } } } },
          member: { include: { organization: true } }
        },
      });

      if (wsMember) {
        request.currentContext = 'WORKSPACE';
        request.currentRole = wsMember.role;
        request.currentMember = wsMember;
        request.organization = wsMember.member.organization;
        return true;
      }

      // 2. FALLBACK: Check if they are Organization Owner/Admin (Implicit Access)
      // We need to fetch the workspace first to know which Org it belongs to
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true }
      });

      if (workspace) {
        const orgMember = await this.prisma.organizationMember.findUnique({
          where: {
            organizationId_userId: { 
              organizationId: workspace.organizationId, 
              userId: user.userId 
            }
          },
          include: { 
            role: { 
              include: { permissions: { include: { permission: true } } } 
            }
          }
        });

        // Implicit access: Owners/Admins get into all workspaces in their Org
        if (orgMember && ['OWNER', 'ADMIN'].includes(orgMember.role.name)) {
             request.currentContext = 'WORKSPACE';
             request.currentRole = orgMember.role; 
             request.currentMember = orgMember; 
             return true;
        }
      }

      throw new ForbiddenException('You are not a member of this workspace.');
    }

    // ====================================================
    // SCENARIO B: User is accessing an ORGANIZATION (Billing/Settings)
    // ====================================================


    if (organizationId) {
      const member = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: organizationId,
            userId: user.userId,
          },
        },
        include: {
          role: {
            include: { permissions: { include: { permission: true } } },
          },
          organization: { select: { status: true } }
        },
      });

      if (!member) {
        throw new ForbiddenException('You are not a member of this organization.');
      }

      if (member.organization.status === 'SUSPENDED') {
      throw new ForbiddenException('This organization has been suspended.');
  }

      // ATTACH CONTEXT
      request.currentContext = 'ORGANIZATION';
      request.currentRole = member.role;
      request.currentMember = member;

      return true;
    }

    // ====================================================
    // SCENARIO C: No Context (e.g. /users/me)
    // ====================================================
    // We don't attach a role, so PermissionsGuard will rely on System Roles 
    // or throw an error if a role was strictly required.
    return true;
  }
}