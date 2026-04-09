import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRule = this.reflector.getAllAndOverride<{
      resource: string;
      action: string;
    }>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRule) return true; // no permission needed

    const request = context.switchToHttp().getRequest();
    const userRoles = request.user?.roles;
    const userPermissions = request.user?.permissions; // lowercase strings

    if (!userRoles || !userPermissions) {
      throw new ForbiddenException('No permission context found');
    }

    // Owners bypass all
    const isOwner = userRoles.some((role) =>
      role.toLowerCase().includes('owner'),
    );
    if (isOwner) return true;

    const resource = requiredRule.resource.toLowerCase();
    const action = requiredRule.action.toLowerCase();

    // Wildcard checks
    if (
      userPermissions.includes('all.manage') || // global admin
      userPermissions.includes(`all.${action}`) || // e.g., allowed to 'read' everything
      userPermissions.includes(`${resource}.all`) || // e.g., allowed to do everything to 'posts'
      userPermissions.includes(`${resource}.manage`) || // e.g., allowed to manage 'organization'
      userPermissions.includes(`${resource}.${action}`) //  EXACT MATCH (e.g., posts.create)
    ) {
      return true;
    }

    throw new ForbiddenException(
      `Permission denied. Required: ${resource}.${action}`,
    );
  }
}
