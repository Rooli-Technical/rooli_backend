import slugify from 'slugify';
import { prisma, hasColumn } from './utils';
import {
  RoleScope,
} from '../../generated/prisma/client';

export const SYSTEM_ROLES = [
  {
    name: 'admin',
    displayName: 'Admin',
    description: 'Full access',
    scope: RoleScope.SYSTEM,
    isSystem: true,
    permissions: ['SYSTEM:ADMIN:MANAGE'],
  },
  {
    name: 'user',
    displayName: 'User',
    description: 'Basic user',
    scope: RoleScope.SYSTEM,
    isSystem: true,
    isDefault: true,
    permissions: ['SYSTEM:USER:READ'],
  },
];

export async function seedRoles(permissionMap: Map<string, string>) {
  const useSlug = await hasColumn('role', 'slug');

  for (const r of SYSTEM_ROLES) {
    let role = await prisma.role.findFirst({
      where: { name: r.name, scope: r.scope, organizationId: null },
    });

    if (!role) {
      role = await prisma.role.create({
        data: {
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          scope: r.scope,
          organizationId: null,
          isSystem: r.isSystem,
          isDefault: r.isDefault,
          ...(useSlug ? { slug: slugify(r.name, { lower: true }) } : {}),
        },
      });
    }

    const rpData = r.permissions.map((code) => {
      const permissionId = permissionMap.get(code);
      return permissionId
        ? { roleId: role!.id, permissionId }
        : null;
    }).filter(Boolean);

    if (rpData.length > 0) {
      await prisma.rolePermission.createMany({
        data: rpData as any,
        skipDuplicates: true,
      });
    }
  }
}