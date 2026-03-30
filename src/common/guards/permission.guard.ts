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
    const userRole = request.currentRole;
    const userPermissions = request.permissions; // lowercase strings

    if (!userRole || !userPermissions) {
      throw new ForbiddenException('No permission context found');
    }

    // Owners bypass all
    if (userRole.slug === 'owner') return true;

    const resource = requiredRule.resource.toLowerCase();
    const action = requiredRule.action.toLowerCase();

    // Wildcard checks
    if (
      userPermissions.includes('ALL.MANAGE') || // global admin
      userPermissions.includes(`ALL.${action}`) || // all.read, all.delete
      userPermissions.includes(`${resource}.ALL`) || // resource.all
      userPermissions.includes(`${resource}.manage`) || // resource.manage
      userPermissions.includes(`${resource}.${action}`) // exact
    ) {
      return true;
    }

    throw new ForbiddenException(
      `Permission denied. Required: ${resource}.${action}`,
    );
  }
}