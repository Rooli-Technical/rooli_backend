import { PrismaClient } from '../../generated/prisma/client';
import {
  RoleScope,
  PermissionScope,
  PermissionResource,
  PermissionAction,
} from '../../generated/prisma/enums';
import { prisma, hasColumn } from './utils';

// --- CONFIGURATION ---
const SCOPE_RESOURCES: Record<PermissionScope, PermissionResource[]> = {
  [PermissionScope.SYSTEM]: [PermissionResource.SYSTEM],
  [PermissionScope.ORGANIZATION]: [
    PermissionResource.ORGANIZATION,
    PermissionResource.MEMBERS,
    PermissionResource.BILLING,
    PermissionResource.SETTINGS,
    PermissionResource.SUBSCRIPTION,
    PermissionResource.INTEGRATION,
    PermissionResource.INVITATIONS,
    PermissionResource.AUDIT_LOGS,
  ],
  [PermissionScope.WORKSPACE]: [
    PermissionResource.POSTS,
    PermissionResource.CONTENT,
    PermissionResource.SCHEDULING,
    PermissionResource.ANALYTICS,
    PermissionResource.MESSAGE,
    PermissionResource.COMMENT,
    PermissionResource.AI_CONTENT,
    PermissionResource.AI_USAGE,
    PermissionResource.TEMPLATE,
    PermissionResource.CALENDAR,
    PermissionResource.INBOX,
  ],
};

const ALL_ACTIONS = Object.values(PermissionAction);

export async function seedRBAC() {
  console.log('🌱 Starting RBAC Seed...');

  const slugExists = await hasColumn('Role', 'slug');
  if (!slugExists) {
    console.error(
      "❌ Aborting: 'slug' column missing in 'Role' table. Run migrations first.",
    );
    return;
  }

  // -----------------------------------------------------
  // 1) SEED PERMISSIONS IN BULK (FAST)
  // -----------------------------------------------------
  console.log('... Seeding Permissions (bulk createMany)');

  const permissionRows = Object.values(PermissionScope).flatMap((scope) => {
    const resources = SCOPE_RESOURCES[scope] ?? [];
    return resources.flatMap((resource) =>
      ALL_ACTIONS.map((action) => ({
        scope,
        resource,
        action,
        name: `${scope}.${resource}.${action}`,
        description: `Allow ${action} on ${resource} in ${scope}`,
      })),
    );
  });

  await prisma.permission.createMany({
    data: permissionRows,
    skipDuplicates: true, // relies on @@unique([scope, resource, action])
  });

  console.log(`✅ Permissions ensured: ${permissionRows.length} combinations`);

  // -----------------------------------------------------
  // 2) HELPERS
  // -----------------------------------------------------
  async function permIds(params: {
    scope: PermissionScope;
    resources?: PermissionResource[];
    actions?: PermissionAction[];
  }) {
    const perms = await prisma.permission.findMany({
      where: {
        scope: params.scope,
        ...(params.resources ? { resource: { in: params.resources } } : {}),
        ...(params.actions ? { action: { in: params.actions } } : {}),
      },
      select: { id: true },
    });
    return perms.map((p) => p.id);
  }

  async function assign(roleId: string, permissionIds: string[]) {
    if (!permissionIds.length) return;

    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true, // relies on @@unique([roleId, permissionId])
    });
  }

  // -----------------------------------------------------
  // 3) SEED ROLES (upsert is fine here, small volume)
  // -----------------------------------------------------
  console.log('... Seeding Roles');

  const sysOwner = await upsertSystemRole({
  scope: RoleScope.SYSTEM,
  slug: 'system-owner',
  name: 'System Owner',
  description: 'Super Admin',
});

const orgOwner = await upsertSystemRole({
  scope: RoleScope.ORGANIZATION,
  slug: 'owner',
  name: 'Owner',
  description: 'Full access to organization billing and settings',
});

const orgAdmin = await upsertSystemRole({
  scope: RoleScope.ORGANIZATION,
  slug: 'admin',
  name: 'Admin',
  description: 'Can manage billing, members, and integrations',
});

const orgMember = await upsertSystemRole({
  scope: RoleScope.ORGANIZATION,
  slug: 'member',
  name: 'Member',
  description: 'Basic membership. Needs workspace access to see content.',
  isDefault: true,
});

const wsOwner = await upsertSystemRole({
  scope: RoleScope.WORKSPACE,
  slug: 'owner',
  name: 'Workspace Owner',
  description: 'Full control over workspace content and settings',
});

const wsEditor = await upsertSystemRole({
  scope: RoleScope.WORKSPACE,
  slug: 'editor',
  name: 'Editor',
  description: 'Can create, edit, delete, and schedule content',
  isDefault: true,
});

const wsViewer = await upsertSystemRole({
  scope: RoleScope.WORKSPACE,
  slug: 'viewer',
  name: 'Viewer',
  description: 'Read-only access to content and analytics',
});
  // -----------------------------------------------------
  // 4) ASSIGN PERMISSIONS (bulk createMany)
  // -----------------------------------------------------
  console.log('... Assigning permissions');

  // System Owner: all SYSTEM permissions
  await assign(sysOwner.id, await permIds({ scope: PermissionScope.SYSTEM }));

  // Org Owner: all ORG permissions
  await assign(orgOwner.id, await permIds({ scope: PermissionScope.ORGANIZATION }));

  // Org Admin: manage core org resources
  await assign(
    orgAdmin.id,
    await permIds({
      scope: PermissionScope.ORGANIZATION,
      resources: [
        PermissionResource.BILLING,
        PermissionResource.MEMBERS,
        PermissionResource.INVITATIONS,
        PermissionResource.INTEGRATION,
        PermissionResource.SETTINGS,
        PermissionResource.AUDIT_LOGS,
      ],
      actions: [
        PermissionAction.MANAGE,
        PermissionAction.READ,
        PermissionAction.CREATE,
        PermissionAction.UPDATE,
        PermissionAction.DELETE,
      ],
    }),
  );

  // Org Member: minimal org read
  await assign(
    orgMember.id,
    await permIds({
      scope: PermissionScope.ORGANIZATION,
      resources: [PermissionResource.ORGANIZATION, PermissionResource.MEMBERS],
      actions: [PermissionAction.READ],
    }),
  );

  // Workspace Owner: all WORKSPACE permissions
  await assign(wsOwner.id, await permIds({ scope: PermissionScope.WORKSPACE }));

  // Workspace Editor: CRUD content + schedule + publish
  await assign(
    wsEditor.id,
    await permIds({
      scope: PermissionScope.WORKSPACE,
      resources: [
        PermissionResource.POSTS,
        PermissionResource.CONTENT,
        PermissionResource.SCHEDULING,
        PermissionResource.CALENDAR,
        PermissionResource.TEMPLATE,
        PermissionResource.MESSAGE,
        PermissionResource.COMMENT,
        PermissionResource.AI_CONTENT,
      ],
      actions: [
        PermissionAction.CREATE,
        PermissionAction.READ,
        PermissionAction.UPDATE,
        PermissionAction.DELETE,
        PermissionAction.PUBLISH,
      ],
    }),
  );

  // Workspace Viewer: read-only
  await assign(
    wsViewer.id,
    await permIds({
      scope: PermissionScope.WORKSPACE,
      resources: [
        PermissionResource.POSTS,
        PermissionResource.CONTENT,
        PermissionResource.ANALYTICS,
        PermissionResource.CALENDAR,
        PermissionResource.SCHEDULING,
      ],
      actions: [PermissionAction.READ],
    }),
  );

  console.log('✅ RBAC Seeding Complete!');
}

async function upsertSystemRole(params: {
  scope: RoleScope;
  slug: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}) {
  const existing = await prisma.role.findFirst({
    where: {
      scope: params.scope,
      slug: params.slug,
      organizationId: null,
    },
    select: { id: true },
  });

  if (existing) return existing;

  return prisma.role.create({
    data: {
      scope: params.scope,
      slug: params.slug,
      name: params.name,
      description: params.description,
      isSystem: true,
      isDefault: params.isDefault ?? false,
      organizationId: null,
    },
    select: { id: true },
  });
}
