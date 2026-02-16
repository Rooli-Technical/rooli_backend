
import {
  PrismaClient,
  PermissionScope,
  PermissionResource,
  PermissionAction,
  RoleScope,
} from '@prisma/client';

const prisma = new PrismaClient();

// -----------------------------------------------------
// 1. CONFIGURATION: VALID SCOPE <-> RESOURCE MAPPING
// -----------------------------------------------------
// This prevents creating "garbage" permissions like "SYSTEM.POSTS"
// or "WORKSPACE.BILLING".
const SCOPE_RESOURCES: Record<PermissionScope, PermissionResource[]> = {
  [PermissionScope.SYSTEM]: [
    PermissionResource.SYSTEM,
    // Add other system-level resources if you have them
  ],
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

async function main() {
  console.log('🌱 Starting RBAC Seed...');

  // -----------------------------------------------------
  // 2. SEED PERMISSIONS (Clean & Scoped)
  // -----------------------------------------------------
  console.log('... Seeding Permissions');

  for (const scope of Object.values(PermissionScope)) {
    const validResources = SCOPE_RESOURCES[scope];

    for (const resource of validResources) {
      for (const action of ALL_ACTIONS) {
        await prisma.permission.upsert({
          where: {
            scope_resource_action: { scope, resource, action },
          },
          update: {},
          create: {
            scope,
            resource,
            action,
            name: `${action} ${resource}`, // e.g. "CREATE POSTS"
            description: `Allow ${action} on ${resource} in ${scope}`,
          },
        });
      }
    }
  }

  // -----------------------------------------------------
  // 3. HELPER FUNCTIONS
  // -----------------------------------------------------
  
  // Fetch IDs for a list of resources/actions within a scope
  async function getPermIDs(
    scope: PermissionScope,
    resources: PermissionResource[],
    actions: PermissionAction[]
  ) {
    const perms = await prisma.permission.findMany({
      where: {
        scope,
        resource: { in: resources },
        action: { in: actions },
      },
      select: { id: true },
    });
    return perms.map((p) => p.id);
  }

  // Fetch ALL permissions for a scope (For Owners)
  async function getAllScopePermIDs(scope: PermissionScope) {
    const perms = await prisma.permission.findMany({
      where: { scope },
      select: { id: true },
    });
    return perms.map((p) => p.id);
  }

  // Assign permissions to a role
  async function assign(roleId: string, permIds: string[]) {
    // Optimization: CreateMany is faster, but Upsert is safer for re-running seeds
    for (const permissionId of permIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        update: {},
        create: { roleId, permissionId },
      });
    }
  }

  // -----------------------------------------------------
  // 4. SYSTEM ROLES
  // -----------------------------------------------------
  console.log('... Seeding System Roles');

  const sysOwner = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.SYSTEM, organizationId: null, slug: 'system-owner' } },
    update: {},
    create: {
      name: 'System Owner',
      slug: 'system-owner',
      scope: RoleScope.SYSTEM,
      description: 'Super Admin',
      isSystem: true,
    },
  });
  await assign(sysOwner.id, await getAllScopePermIDs(PermissionScope.SYSTEM));

  // -----------------------------------------------------
  // 5. ORGANIZATION ROLES
  // -----------------------------------------------------
  console.log('... Seeding Organization Roles');

  // A. ORG OWNER (God Mode for Org)
  const orgOwner = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.ORGANIZATION, organizationId: null, slug: 'owner' } },
    update: {},
    create: {
      name: 'Owner',
      slug: 'owner',
      scope: RoleScope.ORGANIZATION,
      description: 'Full access to organization billing and settings',
      isSystem: true,
      isDefault: false,
    },
  });
  await assign(orgOwner.id, await getAllScopePermIDs(PermissionScope.ORGANIZATION));

  // B. ORG ADMIN (Billing & Members)
  const orgAdmin = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.ORGANIZATION, organizationId: null, slug: 'admin' } },
    update: {},
    create: {
      name: 'Admin',
      slug: 'admin',
      scope: RoleScope.ORGANIZATION,
      description: 'Can manage billing, members, and integrations',
      isSystem: true,
    },
  });
  const orgAdminPerms = await getPermIDs(
    PermissionScope.ORGANIZATION,
    [
      PermissionResource.BILLING,
      PermissionResource.MEMBERS,
      PermissionResource.INVITATIONS,
      PermissionResource.INTEGRATION,
      PermissionResource.SETTINGS,
    ],
    [PermissionAction.MANAGE, PermissionAction.READ, PermissionAction.UPDATE, PermissionAction.CREATE, PermissionAction.DELETE]
  );
  await assign(orgAdmin.id, orgAdminPerms);

  // C. ORG MEMBER (Default - Least Privilege)
  // Org Members only exist to be "In the building". They see nothing until added to a Workspace.
  const orgMember = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.ORGANIZATION, organizationId: null, slug: 'member' } },
    update: {},
    create: {
      name: 'Member',
      slug: 'member',
      scope: RoleScope.ORGANIZATION,
      description: 'Basic membership. Needs workspace access to see content.',
      isSystem: true,
      isDefault: true, // Default for new signups
    },
  });
  const orgMemberPerms = await getPermIDs(
    PermissionScope.ORGANIZATION,
    [PermissionResource.MEMBERS, PermissionResource.ORGANIZATION], 
    [PermissionAction.READ]
  );
  await assign(orgMember.id, orgMemberPerms);

  // -----------------------------------------------------
  // 6. WORKSPACE ROLES
  // -----------------------------------------------------
  console.log('... Seeding Workspace Roles');

  // A. WORKSPACE OWNER
  const wsOwner = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.WORKSPACE, organizationId: null, slug: 'owner' } },
    update: {},
    create: {
      name: 'Workspace Owner',
      slug: 'owner',
      scope: RoleScope.WORKSPACE,
      description: 'Full control over workspace content and settings',
      isSystem: true,
    },
  });
  await assign(wsOwner.id, await getAllScopePermIDs(PermissionScope.WORKSPACE));

  // B. EDITOR (The Standard User)
  const wsEditor = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.WORKSPACE, organizationId: null, slug: 'editor' } },
    update: {},
    create: {
      name: 'Editor',
      slug: 'editor',
      scope: RoleScope.WORKSPACE,
      description: 'Can create, edit, delete, and schedule content',
      isSystem: true,
      isDefault: true,
    },
  });
  const wsEditorPerms = await getPermIDs(
    PermissionScope.WORKSPACE,
    [
      PermissionResource.POSTS,
      PermissionResource.CONTENT,
      PermissionResource.SCHEDULING,
      PermissionResource.CALENDAR,
      PermissionResource.AI_CONTENT,
      PermissionResource.TEMPLATE,
      PermissionResource.COMMENT,
      PermissionResource.MESSAGE, // Community Management
    ],
    // Can do everything EXCEPT "MANAGE" (which might imply nuking the workspace settings)
    [PermissionAction.CREATE, PermissionAction.READ, PermissionAction.UPDATE, PermissionAction.DELETE, PermissionAction.PUBLISH]
  );
  await assign(wsEditor.id, wsEditorPerms);

  // C. VIEWER (Clients / Approvers)
  const wsViewer = await prisma.role.upsert({
    where: { scope_organizationId_slug: { scope: RoleScope.WORKSPACE, organizationId: null, slug: 'viewer' } },
    update: {},
    create: {
      name: 'Viewer',
      slug: 'viewer',
      scope: RoleScope.WORKSPACE,
      description: 'Read-only access to content and analytics',
      isSystem: true,
    },
  });
  const wsViewerPerms = await getPermIDs(
    PermissionScope.WORKSPACE,
    [
      PermissionResource.POSTS,
      PermissionResource.CONTENT,
      PermissionResource.ANALYTICS, // Key for clients
      PermissionResource.CALENDAR,
      PermissionResource.SCHEDULING,
    ],
    [PermissionAction.READ] // Strictly Read-Only
  );
  await assign(wsViewer.id, wsViewerPerms);

  console.log('✅ RBAC Seeding Complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
