import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

import {
  RoleScope,
  PermissionScope,
  PermissionResource,
  PermissionAction,
} from '@generated/enums';
import { handlePrismaError } from '@/common/prisma.utils';
import { Prisma } from '@generated/client';
import { RoleWithPermissions } from '../interfaces/index.interfaces';
import { CreateRoleDto } from '../dtos/create-role.dto';
import slugify from 'slugify';
import { UpdateRoleDto } from '../dtos/update-role.dto';

//Cache role → permissions (in-memory/Redis) for fast permission checks, with invalidation after role updates.

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createRole(createRoleDto: CreateRoleDto): Promise<RoleWithPermissions> {
    try {
      const {
        name,
        description,
        displayName,
        scope,
        organizationId,
        permissionIds = [],
        isDefault = false,
      } = createRoleDto;

      const slug = slugify(name, {
        lower: true,
        strict: true,
      });

      // Validate organization context
      if (scope === RoleScope.ORGANIZATION && !organizationId) {
        throw new ConflictException(
          'Organization ID is required for organization-scoped roles',
        );
      }

      // Check for duplicate role name within organization/scope
      const existingRole = await this.prisma.role.findFirst({
        where: {
          name,
          scope,
          organizationId:
            scope === RoleScope.ORGANIZATION ? organizationId : null,
        },
      });

      if (existingRole) {
        throw new ConflictException(
          `Role with name "${name}" already exists in this scope`,
        );
      }

      // If setting as default, ensure only one default role per scope/organization
      if (isDefault) {
        await this.unsetExistingDefaultRole(scope, organizationId);
      }

      return this.prisma.$transaction(async (tx) => {
        // Create the role
        const role = await tx.role.create({
          data: {
            name,
            slug,
            description,
            displayName,
            scope,
            organizationId:
              scope === RoleScope.ORGANIZATION ? organizationId : null,
            isDefault,
          },
        });

        // Assign permissions if provided
        if (permissionIds.length > 0) {
          await this.assignPermissionsToRole(role.id, permissionIds, tx);
        }

        return this.findRoleWithPermissions(role.id, tx);
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        handlePrismaError(err);
        throw err;
      }
    }
  }

  async findRoleWithPermissions(
    roleId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RoleWithPermissions> {
    try {
      const prisma = tx || this.prisma;

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      });

      if (!role) {
        throw new NotFoundException(`Role with ID ${roleId} not found`);
      }

      return {
        ...role,
        permissions: role.permissions.map((rp) => rp.permission),
      };
    } catch (err) {
      throw err;
    }
  }

  async updateRole(
    roleId: string,
    updateRoleDto: UpdateRoleDto,
  ): Promise<RoleWithPermissions> {
    const { name, description, displayName, permissionIds, isDefault } =
      updateRoleDto;

    const existingRole = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!existingRole) {
      throw new NotFoundException(`Role with ID ${roleId} not found`);
    }

    if (existingRole.isSystem) {
      throw new ForbiddenException('Cannot modify system roles');
    }

    // Check for name conflict
    if (name && name !== existingRole.name) {
      const nameExists = await this.prisma.role.findFirst({
        where: {
          name,
          scope: existingRole.scope,
          organizationId: existingRole.organizationId,
          id: { not: roleId },
        },
      });

      if (nameExists) {
        throw new ConflictException(
          `Role with name "${name}" already exists in this scope`,
        );
      }
    }

    // Handle default role setting
    if (isDefault && !existingRole.isDefault) {
      await this.unsetExistingDefaultRole(
        existingRole.scope,
        existingRole.organizationId,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Update role
      await tx.role.update({
        where: { id: roleId },
        data: {
          ...(name && { name }),
          ...(description && { description }),
          ...(displayName && { displayName }),
          ...(isDefault !== undefined && { isDefault }),
        },
      });

      // Update permissions if provided
      if (permissionIds) {
        await this.setRolePermissions(roleId, permissionIds, tx);
      }

      return this.findRoleWithPermissions(roleId, tx);
    });
  }

  async assignPermissionsToRole(
    roleId: string,
    permissionIds: string[],
    tx?: any,
  ): Promise<void> {
    const prisma = tx || this.prisma;

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException(`Role with ID ${roleId} not found`);
    }

    // Verify all permissions exist and match role scope
    const permissions = await prisma.permission.findMany({
      where: { id: { in: permissionIds } },
    });

    if (permissions.length !== permissionIds.length) {
      throw new NotFoundException('One or more permissions not found');
    }

    // Check scope compatibility
    const invalidScope = permissions.find((p) => p.scope !== role.scope);
    if (invalidScope) {
      throw new ConflictException(
        `Permission scope ${invalidScope.scope} does not match role scope ${role.scope}`,
      );
    }

    // Create role-permission relationships
    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({
        roleId,
        permissionId,
      })),
      skipDuplicates: true,
    });
  }

  async setRolePermissions(
    roleId: string,
    permissionIds: string[],
    tx?: any,
  ): Promise<void> {
    const prisma = tx || this.prisma;

    await prisma.rolePermission.deleteMany({
      where: { roleId },
    });

    if (permissionIds.length > 0) {
      await this.assignPermissionsToRole(roleId, permissionIds, tx);
    }
  }

  async deleteRole(roleId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        organizationMembers: true,
        socialAccountMembers: true,
      },
    });

    if (!role) {
      throw new NotFoundException(`Role with ID ${roleId} not found`);
    }

    if (role.isSystem) {
      throw new ForbiddenException('Cannot delete system roles');
    }

    const orgMemberCount = await this.prisma.organizationMember.count({
      where: { roleId },
    });
    const saMemberCount = await this.prisma.socialAccountMember.count({
      where: { roleId },
    });
    if (orgMemberCount > 0 || saMemberCount > 0) {
      throw new ConflictException(
        'Cannot delete role that is assigned to members',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Remove all permissions
      await tx.rolePermission.deleteMany({
        where: { roleId },
      });

      // Delete the role
      await tx.role.delete({
        where: { id: roleId },
      });
    });
  }

  async findOrganizationRoles(
    organizationId: string,
  ): Promise<RoleWithPermissions[]> {
    const roles = await this.prisma.role.findMany({
      where: {
        scope: RoleScope.ORGANIZATION,
        organizationId,
      },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((rp) => rp.permission),
    }));
  }

  async findSystemRoles(scope?: RoleScope): Promise<RoleWithPermissions[]> {
    const where: any = { isSystem: true };
    if (scope) {
      where.scope = scope;
    }

    const roles = await this.prisma.role.findMany({
      where,
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    return roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((rp) => rp.permission),
    }));
  }

  async getDefaultRole(
    scope: RoleScope,
    organizationId?: string,
  ): Promise<RoleWithPermissions | null> {
    const where: any = {
      scope,
      isDefault: true,
    };

    if (scope === RoleScope.ORGANIZATION) {
      where.organizationId = organizationId;
    } else {
      where.organizationId = null;
    }

    const role = await this.prisma.role.findFirst({
      where,
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });

    if (!role) return null;

    return {
      ...role,
      permissions: role.permissions.map((rp) => rp.permission),
    };
  }

  private async unsetExistingDefaultRole(
    scope: RoleScope,
    organizationId?: string,
  ): Promise<void> {
    const where: any = {
      scope,
      isDefault: true,
    };

    if (scope === RoleScope.ORGANIZATION) {
      where.organizationId = organizationId;
    } else {
      where.organizationId = null;
    }

    await this.prisma.role.updateMany({
      where,
      data: { isDefault: false },
    });
  }

  async seedSystemRoles(): Promise<void> {
    const systemRoles = [
      // Organization roles
      {
        name: 'owner',
        displayName: 'Owner',
        description: 'Full organization ownership with all permissions',
        scope: RoleScope.ORGANIZATION,
        isSystem: true,
        permissions: ['ORGANIZATION:ORGANIZATION:MANAGE'],
      },
      {
        name: 'admin',
        displayName: 'Admin',
        description: 'Organization administrator with management permissions',
        scope: RoleScope.ORGANIZATION,
        isSystem: true,
        permissions: [
          'ORGANIZATION:MEMBERS:MANAGE',
          'ORGANIZATION:SETTINGS:MANAGE',
        ],
      },
      {
        name: 'member',
        displayName: 'Member',
        description: 'Standard organization member',
        scope: RoleScope.ORGANIZATION,
        isSystem: true,
        isDefault: true,
        permissions: ['ORGANIZATION:MEMBERS:READ'],
      },

      // Social Account roles
      {
        name: 'manager',
        displayName: 'Social Manager',
        description: 'Full social account management',
        scope: RoleScope.SOCIAL_ACCOUNT,
        isSystem: true,
        permissions: [
          'SOCIAL_ACCOUNT:POSTS:CREATE',
          'SOCIAL_ACCOUNT:SCHEDULING:MANAGE',
        ],
      },
      {
        name: 'contributor',
        displayName: 'Contributor',
        description: 'Can create and schedule content',
        scope: RoleScope.SOCIAL_ACCOUNT,
        isSystem: true,
        isDefault: true,
        permissions: [
          'SOCIAL_ACCOUNT:POSTS:CREATE',
          'SOCIAL_ACCOUNT:SCHEDULING:MANAGE',
        ],
      },
    ];

    for (const roleData of systemRoles) {
      try {
        // Find or create permissions first
        const permissionIds = [];
        for (const permString of roleData.permissions) {
          const [scope, resource, action] = permString.split(':');
          const permission = await this.prisma.permission.findFirst({
            where: {
              scope: scope as PermissionScope,
              resource: resource as PermissionResource,
              action: action as PermissionAction,
            },
          });
          if (permission) {
            permissionIds.push(permission.id);
          }
        }

        await this.createRole({
          name: roleData.name,
          displayName: roleData.displayName,
          description: roleData.description,
          scope: roleData.scope,
          isDefault: roleData.isDefault,
          permissionIds,
        });
      } catch (error) {
        if (error instanceof ConflictException) {
          this.logger.log(`Role already exists: ${roleData.name}`);
          continue;
        }
        throw error;
      }
    }

    this.logger.log('System roles seeded successfully');
  }
}
