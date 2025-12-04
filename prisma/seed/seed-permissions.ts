import { prisma } from './utils';
import {
  PermissionAction,
  PermissionResource,
  PermissionScope,
} from '../../generated/prisma/client';

export const SYSTEM_PERMISSIONS = [
  { name: 'Admin', scope: PermissionScope.SYSTEM, resource: PermissionResource.SYSTEM, action: PermissionAction.MANAGE },
  { name: 'User',  scope: PermissionScope.SYSTEM, resource: PermissionResource.SYSTEM, action: PermissionAction.READ },

  { name: 'Organization Management',  scope: PermissionScope.ORGANIZATION, resource: PermissionResource.ORGANIZATION, action: PermissionAction.MANAGE },
  { name: 'Member Management',        scope: PermissionScope.ORGANIZATION, resource: PermissionResource.MEMBERS,     action: PermissionAction.MANAGE },
  { name: 'View Members',             scope: PermissionScope.ORGANIZATION, resource: PermissionResource.MEMBERS,     action: PermissionAction.READ },
  { name: 'Billing Management',       scope: PermissionScope.ORGANIZATION, resource: PermissionResource.BILLING,     action: PermissionAction.MANAGE },
  { name: 'Settings Management',      scope: PermissionScope.ORGANIZATION, resource: PermissionResource.SETTINGS,    action: PermissionAction.MANAGE },

  { name: 'Post Creation',            scope: PermissionScope.SOCIAL_ACCOUNT, resource: PermissionResource.POSTS,     action: PermissionAction.CREATE },
  { name: 'Post Scheduling',          scope: PermissionScope.SOCIAL_ACCOUNT, resource: PermissionResource.SCHEDULING,action: PermissionAction.MANAGE },
  { name: 'View Analytics',           scope: PermissionScope.SOCIAL_ACCOUNT, resource: PermissionResource.ANALYTICS, action: PermissionAction.READ },
  { name: 'Manage Messages',          scope: PermissionScope.SOCIAL_ACCOUNT, resource: PermissionResource.MESSAGE,   action: PermissionAction.MANAGE },
];

export async function seedPermissions() {
  await prisma.permission.createMany({
    data: SYSTEM_PERMISSIONS,
    skipDuplicates: true,
  });

  const perms = await prisma.permission.findMany();
  const map = new Map<string, string>();

  for (const p of perms) {
    const key = `${p.scope}:${p.resource}:${p.action}`;
    map.set(key, p.id);
  }

  return map;
}