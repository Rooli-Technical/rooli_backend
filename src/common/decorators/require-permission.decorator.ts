import { SetMetadata } from '@nestjs/common';
import { PermissionResource, PermissionAction } from '../constants/rbac';

export const PERMISSION_KEY = 'permission';

// Usage: @RequirePermission(PermissionResource.POSTS, PermissionAction.CREATE)
export const RequirePermission = (
  resource: PermissionResource,
  action: PermissionAction,
) => SetMetadata(PERMISSION_KEY, { resource, action });
