import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { PermissionResource, PermissionAction } from '@generated/enums';


@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Get the Required Permission from the Decorator
    const requiredRule = this.reflector.getAllAndOverride<{
      resource: PermissionResource;
      action: PermissionAction;
    }>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    // If no permission is required, allow access (Public within the workspace)
    if (!requiredRule) {
      return true;
    }

    // 2. Get the User Context (Loaded by ContextGuard)
    const request = context.switchToHttp().getRequest();
    const userRole = request.currentRole;
    const userPermissions = request.permissions; // e.g. ["POSTS.CREATE", "POSTS.READ"]

    if (!userRole || !userPermissions) {
      throw new ForbiddenException('No permission context found');
    }

    if (userRole.slug === 'owner') return true;

    // ---------------------------------------------------------
    // 2. PERMISSION WILDCARDS (The "Cascading Check")
    // ---------------------------------------------------------
    
    // A. GLOBAL ADMIN: "ALL.MANAGE"
    // Can do absolutely anything in this scope.
    if (userPermissions.includes(`ALL.MANAGE`)) return true;

    // B. GLOBAL ACTION: "ALL.READ" or "ALL.DELETE"
    if (userPermissions.includes(`ALL.${requiredRule.action}`)) return true;

    // C. RESOURCE ADMIN: "POSTS.ALL" or "POSTS.MANAGE"
    if (userPermissions.includes(`${requiredRule.resource}.ALL`)) return true;
    if (userPermissions.includes(`${requiredRule.resource}.MANAGE`)) return true;

    // D. EXACT MATCH: "POSTS.CREATE"
    // The standard check for granular permissions.
    if (userPermissions.includes(`${requiredRule.resource}.${requiredRule.action}`)) return true;

    // ---------------------------------------------------------
    // 3. FAILURE
    // ---------------------------------------------------------
    throw new ForbiddenException(
      `Permission denied. Required: ${requiredRule.resource}.${requiredRule.action}`
    );
  }
}


