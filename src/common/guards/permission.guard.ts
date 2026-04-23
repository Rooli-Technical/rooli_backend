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

    if (!requiredRule) return true;

    const request = context.switchToHttp().getRequest();
    
    // FIX: Read directly from the context populated by ContextGuard
    const userPermissions = request.permissions; 
    const currentRole = request.currentRole;

    if (!userPermissions) {
      throw new ForbiddenException('No permission context found. Is ContextGuard running before PermissionsGuard?');
    }

    // FIX: Check if the dynamically attached role is an Owner
    const isOwner = currentRole?.name?.toLowerCase().includes('owner') || currentRole?.slug?.toLowerCase().includes('owner');
    
    if (isOwner) return true;

    const resource = requiredRule.resource.toLowerCase();
    const action = requiredRule.action.toLowerCase();

    // Wildcard checks
    if (
      userPermissions.includes('all.manage') || 
      userPermissions.includes(`all.${action}`) || 
      userPermissions.includes(`${resource}.all`) || 
      userPermissions.includes(`${resource}.manage`) || 
      userPermissions.includes(`${resource}.${action}`) 
    ) {
      return true;
    }

    throw new ForbiddenException(
      `Permission denied. Required: ${resource}.${action}`,
    );
  }
}
