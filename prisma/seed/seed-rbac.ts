import {
  RoleScope,
  PermissionScope,
  PermissionResource,
  PermissionAction,
} from '../../generated/prisma/enums';
import { prisma } from './utils';

export async function seedRBAC() {
  // -------------------------
  // 1. Seed Roles
  // -------------------------
  const rolesData = [
    // SYSTEM
    {
      name: 'SUPER_ADMIN',
      displayName: 'Super Admin',
      scope: RoleScope.SYSTEM,
      isSystem: true,
      isDefault: false,
    },
     {
      name: 'USER',
      displayName: 'USER',
      scope: RoleScope.SYSTEM,
      isSystem: true,
      isDefault: true,
    },
    {
      name: 'SUPPORT',
      displayName: 'Support',
      scope: RoleScope.SYSTEM,
      isSystem: true,
      isDefault: false,
    },
    {
      name: 'FINANCE',
      displayName: 'Finance',
      scope: RoleScope.SYSTEM,
      isSystem: true,
      isDefault: false,
    },

    // ORGANIZATION
    {
      name: 'OWNER',
      displayName: 'Owner',
      scope: RoleScope.ORGANIZATION,
      isSystem: true,
      isDefault: true,
    },
    {
      name: 'ADMIN',
      displayName: 'Admin',
      scope: RoleScope.ORGANIZATION,
      isSystem: true,
      isDefault: false,
    },
    {
      name: 'MEMBER',
      displayName: 'Member',
      scope: RoleScope.ORGANIZATION,
      isSystem: true,
      isDefault: false,
    },
    {
      name: 'VIEWER',
      displayName: 'Viewer',
      scope: RoleScope.ORGANIZATION,
      isSystem: true,
      isDefault: false,
    },

    // WORKSPACE
    {
      name: 'WORKSPACE_ADMIN',
      displayName: 'Workspace Admin',
      scope: RoleScope.WORKSPACE,
      isSystem: true,
      isDefault: true,
    },
    {
      name: 'EDITOR',
      displayName: 'Editor',
      scope: RoleScope.WORKSPACE,
      isSystem: true,
      isDefault: false,
    },
    {
      name: 'CONTRIBUTOR',
      displayName: 'Contributor',
      scope: RoleScope.WORKSPACE,
      isSystem: true,
      isDefault: false,
    },
    {
      name: 'VIEWER',
      displayName: 'Viewer',
      scope: RoleScope.WORKSPACE,
      isSystem: true,
      isDefault: false,
    },
  ];

  const roles = [];
  for (const r of rolesData) {
    // 1. Try to find the role using a standard where clause
    // This works because standard 'where' converts null to "IS NULL" SQL
    const existingRole = await prisma.role.findFirst({
      where: {
        name: r.name,
        scope: r.scope,
        organizationId: null,
      },
    });

    if (existingRole) {
      // 2. Update if exists
      const role = await prisma.role.update({
        where: { id: existingRole.id }, // Use the concrete ID found above
        data: r,
      });
      roles.push(role);
    } else {
      // 3. Create if it doesn't exist
      const role = await prisma.role.create({
        data: {
          ...r,
          organizationId: null,
        },
      });
      roles.push(role);
    }
  }

  // -------------------------
  // 2. Seed Permissions
  // -------------------------
  const permissionsData = [
    // SYSTEM
    {
      name: 'ALL_SYSTEM',
      scope: PermissionScope.SYSTEM,
      resource: 'ALL',
      action: 'ALL',
      description: 'Full system access',
    },

    // ORGANIZATION
    {
      name: 'MANAGE_ORG',
      scope: PermissionScope.ORGANIZATION,
      resource: 'ORGANIZATION',
      action: 'MANAGE',
      description: 'Manage organization',
    },
    {
      name: 'MANAGE_MEMBERS',
      scope: PermissionScope.ORGANIZATION,
      resource: 'MEMBERS',
      action: 'MANAGE',
      description: 'Manage org members',
    },
    {
      name: 'MANAGE_BILLING',
      scope: PermissionScope.ORGANIZATION,
      resource: 'BILLING',
      action: 'MANAGE',
      description: 'Billing access',
    },
    {
      name: 'MANAGE_SUBSCRIPTION',
      scope: PermissionScope.ORGANIZATION,
      resource: 'SUBSCRIPTION',
      action: 'MANAGE',
      description: 'Subscription access',
    },
    {
      name: 'MANAGE_SETTINGS',
      scope: PermissionScope.ORGANIZATION,
      resource: 'SETTINGS',
      action: 'MANAGE',
      description: 'Org settings',
    },
    {
      name: 'MANAGE_INTEGRATIONS',
      scope: PermissionScope.ORGANIZATION,
      resource: 'INTEGRATION',
      action: 'MANAGE',
      description: 'Manage integrations',
    },
    {
      name: 'MANAGE_INVITATIONS',
      scope: PermissionScope.ORGANIZATION,
      resource: 'INVITATIONS',
      action: 'MANAGE',
      description: 'Invite members',
    },
    {
      name: 'VIEW_AUDIT_LOGS',
      scope: PermissionScope.ORGANIZATION,
      resource: 'AUDIT_LOGS',
      action: 'READ',
      description: 'View logs',
    },
    //add @WorkspaceAuth({ resource: 'SOCIAL_ACCOUNT', action: 'READ' })

    // WORKSPACE
    {
      name: 'MANAGE_POSTS',
      scope: PermissionScope.WORKSPACE,
      resource: 'POSTS',
      action: 'MANAGE',
      description: 'Manage posts',
    },
    {
      name: 'READ_DRAFTS',
      scope: PermissionScope.WORKSPACE,
      resource: 'DRAFT',
      action: 'READ',
      description: 'Read drafts',
    },
    {
      name: 'MANAGE_CONTENT',
      scope: PermissionScope.WORKSPACE,
      resource: 'CONTENT',
      action: 'MANAGE',
      description: 'Manage content',
    },
    {
      name: 'MANAGE_SCHEDULING',
      scope: PermissionScope.WORKSPACE,
      resource: 'SCHEDULING',
      action: 'MANAGE',
      description: 'Schedule posts',
    },
    {
      name: 'VIEW_ANALYTICS',
      scope: PermissionScope.WORKSPACE,
      resource: 'ANALYTICS',
      action: 'READ',
      description: 'View analytics',
    },
    {
      name: 'MANAGE_MESSAGES',
      scope: PermissionScope.WORKSPACE,
      resource: 'MESSAGE',
      action: 'MANAGE',
      description: 'Inbox messages',
    },
    {
      name: 'MANAGE_COMMENTS',
      scope: PermissionScope.WORKSPACE,
      resource: 'COMMENT',
      action: 'MANAGE',
      description: 'Moderate comments',
    },
    {
      name: 'MANAGE_AI_CONTENT',
      scope: PermissionScope.WORKSPACE,
      resource: 'AI_CONTENT',
      action: 'MANAGE',
      description: 'AI content',
    },
    {
      name: 'VIEW_AI_USAGE',
      scope: PermissionScope.WORKSPACE,
      resource: 'AI_USAGE',
      action: 'READ',
      description: 'AI usage',
    },
    {
      name: 'MANAGE_TEMPLATES',
      scope: PermissionScope.WORKSPACE,
      resource: 'TEMPLATE',
      action: 'MANAGE',
      description: 'Templates',
    },
    {
      name: 'MANAGE_SCHEDULE',
      scope: PermissionScope.WORKSPACE,
      resource: 'SCHEDULE',
      action: 'MANAGE',
      description: 'Schedule management',
    },
    {
      name: 'MANAGE_CALENDAR',
      scope: PermissionScope.WORKSPACE,
      resource: 'CALENDAR',
      action: 'MANAGE',
      description: 'Calendar management',
    },
    {
      name: 'MANAGE_INBOX',
      scope: PermissionScope.WORKSPACE,
      resource: 'INBOX',
      action: 'MANAGE',
      description: 'Inbox',
    },
  ];

  const permissions = [];
  for (const p of permissionsData) {
    // FIX: Cast string values to Enum types here
    const resource = p.resource as PermissionResource;
    const action = p.action as PermissionAction;

    const perm = await prisma.permission.upsert({
      where: {
        scope_resource_action: {
          scope: p.scope,
          resource: resource,
          action: action,
        },
      },
      // Spread 'p' but overwrite resource/action with typed versions
      update: {
        ...p,
        resource: resource,
        action: action,
      },
      create: {
        ...p,
        resource: resource,
        action: action,
      },
    });
    permissions.push(perm);
  }

  // -------------------------
  // 3. Assign default RolePermissions
  // -------------------------
  const rolePermMap: Record<string, PermissionScope[]> = {
    SUPER_ADMIN: [
      PermissionScope.SYSTEM,
      PermissionScope.ORGANIZATION,
      PermissionScope.WORKSPACE,
    ],
    SUPPORT: [PermissionScope.SYSTEM],
    FINANCE: [PermissionScope.ORGANIZATION],
    OWNER: [PermissionScope.ORGANIZATION],
    ADMIN: [PermissionScope.ORGANIZATION],
    MEMBER: [PermissionScope.ORGANIZATION],
    WORKSPACE_ADMIN: [PermissionScope.WORKSPACE],
    EDITOR: [PermissionScope.WORKSPACE],
    CONTRIBUTOR: [PermissionScope.WORKSPACE],
    VIEWER: [PermissionScope.WORKSPACE],
  };

  for (const role of roles) {
    // Check if role exists in map
    if (!rolePermMap[role.name]) continue;

    const scopes = rolePermMap[role.name];
    const permsToAssign = permissions.filter((p) => scopes.includes(p.scope));

    for (const perm of permsToAssign) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
        create: { roleId: role.id, permissionId: perm.id },
        update: {},
      });
    }
  }
}
