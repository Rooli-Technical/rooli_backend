import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Reflector } from '@nestjs/core';

@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) return true;

    // 2. ID Resolution: Check 'id' (standard) AND 'orgId' (DTOs)
    const orgId = request.params.id || request.params.orgId || request.body.orgId;

    if (!orgId) throw new ForbiddenException('Organization Context Missing');

    // 3. Super Admin Bypass
    if (user?.systemRole?.name === 'super_admin') {
      request.organizationId = orgId;
      return true;
    }

    // 4. Optimized Query (Member + Role + Permissions in ONE go)
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: orgId, userId: user.id },
      },
      include: {
        role: {
          include: { permissions: true } // Eager load permissions
        }
      }
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    // 5. Attach Context for the Next Guard
    request.member = membership;
    request.currentRole = membership.role;
    request.organizationId = orgId;

    return true;
  }
}