import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@generated/client';
import { PermissionScope, PermissionResource, PermissionAction, RoleScope } from '@generated/enums';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateRoleDto } from './dtos/create-role.dto';
import { ListRolesQuery } from './dtos/list-roles-query.dto';
import { ReplaceRolePermissionsDto } from './dtos/replace-role-permissions.dto';
import { UpdateRoleDto } from './dtos/update-role.dto';
import { ListPermissionsQuery, PermissionNameFormat } from './dtos/list-permissions-query.dto';

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}
  async getAllRolesWithPermissions() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
      orderBy: {
        scope: 'asc',
      },
    });

    // Map the nested Prisma structure to a cleaner response
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      slug: role.slug,
      scope: role.scope,
      description: role.description,
      isSystem: role.isSystem,
      isDefault: role.isDefault,
      permissions: role.permissions.map((rp) => ({
        id: rp.permission.id,
        scope: rp.permission.scope,
        resource: rp.permission.resource,
        action: rp.permission.action,
        name: rp.permission.name,
      })),
    }));
  }


  async listPermissions(query?: ListPermissionsQuery) {
    const where: Prisma.PermissionWhereInput = {
      ...(query?.scope ? { scope: query.scope } : {}),
    };

    return this.prisma.permission.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
    });
  }

  /**
   * Returns enum metadata for UI rendering.
   */
  getPermissionCatalog() {
    return {
      scopes: Object.values(PermissionScope),
      resources: Object.values(PermissionResource),
      actions: Object.values(PermissionAction),
    };
  }

  /**
   * Returns effective permissions for the current request context.
   * Use this for frontend feature gating.
   */
  getMyPermissionsFromRequest(req: any, format: PermissionNameFormat = 'RESOURCE_ACTION') {
    const permissions: string[] = req?.permissions ?? [];
    const context: 'WORKSPACE' | 'ORGANIZATION' | undefined = req?.currentContext;

    if (format === 'RESOURCE_ACTION') return permissions;

    // If your permissions are stored as "POSTS.CREATE" already, just return them.
    // If you decide to store as "SCOPE.RESOURCE.ACTION", you can prepend scope here.
    if (!context) return permissions;

    // If permissions already have scope prefix, do nothing.
    if (permissions.some((p) => p.startsWith('WORKSPACE.') || p.startsWith('ORGANIZATION.'))) {
      return permissions;
    }

    return permissions.map((p) => `${context}.${p}`);
  }

  // ============================================================
  // ROLES
  // ============================================================

  /**
   * List roles visible in an organization.
   * Returns: system roles (organizationId null) + org roles (organizationId = orgId)
   */
  async listOrganizationRoles(params: {
    userId: string;
    organizationId: string;
    query?: ListRolesQuery;
  }) {
    const { userId, organizationId, query } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const scope = query?.scope;
    const includeSystem = query?.includeSystem ?? true;

    const where: Prisma.RoleWhereInput = {
      ...(scope ? { scope } : { scope: { in: [RoleScope.ORGANIZATION, RoleScope.WORKSPACE] } }),
      OR: [
        { organizationId }, // org-specific roles
        ...(includeSystem ? [{ organizationId: null, isSystem: true }] : []), // system templates
      ],
    };

    return this.prisma.role.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { isSystem: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        scope: true,
        organizationId: true,
        name: true,
        slug: true,
        description: true,
        isSystem: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getRole(params: { userId: string; organizationId: string; roleId: string }) {
    const { userId, organizationId, roleId } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (!role) throw new NotFoundException('Role not found');

    // role visible if system role OR belongs to org
    if (!(role.organizationId === null && role.isSystem) && role.organizationId !== organizationId) {
      throw new ForbiddenException('Role not accessible in this organization');
    }

    return role;
  }

  /**
   * Create a custom role for an org.
   * Rules:
   * - cannot create SYSTEM scope via API
   * - slug unique per (scope, orgId)
   * - optionally set default role (enforce one default per org+scope)
   * - attach initial permissions (optional)
   */
  async createRole(params: {
    userId: string;
    organizationId: string;
    dto: CreateRoleDto;
  }) {
    const { userId, organizationId, dto } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    if (dto.scope === RoleScope.SYSTEM) {
      throw new BadRequestException('SYSTEM roles cannot be created');
    }

    const slug = this.normalizeSlug(dto.slug);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Role name is required');

    // ensure slug unique within org+scope
    const existing = await this.prisma.role.findFirst({
      where: { organizationId, scope: dto.scope, slug },
      select: { id: true },
    });
    if (existing) throw new BadRequestException(`Role slug "${slug}" already exists`);

    // validate permission IDs belong to the right PermissionScope
    if (dto.permissionIds?.length) {
      await this.assertPermissionIdsMatchRoleScope(dto.scope, dto.permissionIds);
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        // clear previous defaults for this org+scope
        await tx.role.updateMany({
          where: { organizationId, scope: dto.scope, isDefault: true },
          data: { isDefault: false },
        });
      }

      const role = await tx.role.create({
        data: {
          organizationId,
          scope: dto.scope,
          name,
          slug,
          description: dto.description ?? null,
          isSystem: false,
          isDefault: dto.isDefault ?? false,
        },
        select: { id: true, scope: true, organizationId: true, name: true, slug: true },
      });

      if (dto.permissionIds?.length) {
        await tx.rolePermission.createMany({
          data: dto.permissionIds.map((permissionId) => ({
            roleId: role.id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }

      return role;
    });
  }

  /**
   * Update role metadata (NOT permissions).
   * Disallows editing system roles.
   */
  async updateRole(params: {
    userId: string;
    organizationId: string;
    roleId: string;
    dto: UpdateRoleDto;
  }) {
    const { userId, organizationId, roleId, dto } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, organizationId: true, isSystem: true, scope: true, isDefault: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    if (role.isSystem || role.organizationId === null) {
      throw new ForbiddenException('System roles cannot be modified');
    }
    if (role.organizationId !== organizationId) {
      throw new ForbiddenException('Role does not belong to this organization');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.role.updateMany({
          where: { organizationId, scope: role.scope, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.role.update({
        where: { id: roleId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        },
      });
    });
  }

  /**
   * Replace role permissions completely (bulk).
   * Disallows editing system roles.
   */
  async replaceRolePermissions(params: {
    userId: string;
    organizationId: string;
    roleId: string;
    dto: ReplaceRolePermissionsDto;
  }) {
    const { userId, organizationId, roleId, dto } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, scope: true, organizationId: true, isSystem: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    if (role.isSystem || role.organizationId === null) {
      throw new ForbiddenException('System roles cannot be modified');
    }
    if (role.organizationId !== organizationId) {
      throw new ForbiddenException('Role does not belong to this organization');
    }

    const permissionIds = [...new Set(dto.permissionIds ?? [])];
    await this.assertPermissionIdsMatchRoleScope(role.scope, permissionIds);

    return this.prisma.$transaction(async (tx) => {
      // delete existing mappings
      await tx.rolePermission.deleteMany({ where: { roleId } });

      // insert new mappings
      if (permissionIds.length) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        });
      }

      return tx.role.findUnique({
        where: { id: roleId },
        include: {
          permissions: { include: { permission: true } },
        },
      });
    });
  }

  /**
   * Delete a custom role.
   * Blocks:
   * - system roles
   * - roles assigned to any org members
   * - roles assigned as workspace overrides
   * You can add “transfer members to another role” later.
   */
  async deleteRole(params: { userId: string; organizationId: string; roleId: string }) {
    const { userId, organizationId, roleId } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, organizationId: true, isSystem: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    if (role.isSystem || role.organizationId === null) {
      throw new ForbiddenException('System roles cannot be deleted');
    }
    if (role.organizationId !== organizationId) {
      throw new ForbiddenException('Role does not belong to this organization');
    }

    const [orgMemberUsage, wsMemberUsage] = await this.prisma.$transaction([
      this.prisma.organizationMember.count({ where: { roleId } }),
      this.prisma.workspaceMember.count({ where: { roleId } }),
    ]);

    if (orgMemberUsage > 0 || wsMemberUsage > 0) {
      throw new BadRequestException(
        `Role is in use (orgMembers=${orgMemberUsage}, workspaceOverrides=${wsMemberUsage}). Reassign members first.`,
      );
    }

    await this.prisma.role.delete({ where: { id: roleId } });
    return { deleted: true };
  }

  /**
   * Validate role slug uniqueness (useful for frontend).
   */
  async validateRoleSlug(params: {
    userId: string;
    organizationId: string;
    scope: RoleScope;
    slug: string;
  }) {
    const { userId, organizationId, scope } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const slug = this.normalizeSlug(params.slug);
    const exists = await this.prisma.role.findFirst({
      where: { organizationId, scope, slug },
      select: { id: true },
    });

    return { slug, available: !exists };
  }

  /**
   * Return how many members/overrides are using a role.
   */
  async getRoleUsage(params: { userId: string; organizationId: string; roleId: string }) {
    const { userId, organizationId, roleId } = params;

    await this.assertOrgMemberOrThrow({ organizationId, userId });

    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, organizationId: true, isSystem: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    if (!(role.organizationId === null && role.isSystem) && role.organizationId !== organizationId) {
      throw new ForbiddenException('Role not accessible in this organization');
    }

    const [orgMembers, workspaceOverrides] = await this.prisma.$transaction([
      this.prisma.organizationMember.count({ where: { roleId } }),
      this.prisma.workspaceMember.count({ where: { roleId } }),
    ]);

    return { roleId, orgMembers, workspaceOverrides };
  }

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  private async assertOrgMemberOrThrow(params: { organizationId: string; userId: string }) {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: params.organizationId,
          userId: params.userId,
        },
      },
      include: { organization: { select: { status: true } } },
    });

    if (!member) throw new ForbiddenException('Not a member of this organization');
    if ((member as any).deletedAt) throw new ForbiddenException('Membership inactive');
    if (member.organization.status === 'SUSPENDED') throw new ForbiddenException('Organization is suspended');

    return member;
  }

  /**
   * Enforce that permission IDs match the role scope:
   * RoleScope.ORGANIZATION -> PermissionScope.ORGANIZATION
   * RoleScope.WORKSPACE    -> PermissionScope.WORKSPACE
   * RoleScope.SYSTEM       -> PermissionScope.SYSTEM
   */
  private async assertPermissionIdsMatchRoleScope(roleScope: RoleScope, permissionIds: string[]) {
    if (!permissionIds.length) return;

    const requiredPermissionScope =
      roleScope === RoleScope.ORGANIZATION
        ? PermissionScope.ORGANIZATION
        : roleScope === RoleScope.WORKSPACE
          ? PermissionScope.WORKSPACE
          : PermissionScope.SYSTEM;

    const perms = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { id: true, scope: true },
    });

    const foundIds = new Set(perms.map((p) => p.id));
    const missing = permissionIds.filter((id) => !foundIds.has(id));
    if (missing.length) throw new BadRequestException(`Invalid permission IDs: ${missing.join(', ')}`);

    const wrongScope = perms.filter((p) => p.scope !== requiredPermissionScope).map((p) => p.id);
    if (wrongScope.length) {
      throw new BadRequestException(
        `Permissions must be ${requiredPermissionScope} scope for a ${roleScope} role. Wrong: ${wrongScope.join(', ')}`,
      );
    }
  }

  private normalizeSlug(input: string) {
    const s = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    if (!s) throw new BadRequestException('Slug cannot be empty');
    if (s.length > 64) throw new BadRequestException('Slug too long (max 64)');
    return s;
  }
}
