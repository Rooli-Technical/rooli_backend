import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

import { RoleScope } from '@generated/enums';
import { CreateRoleDto } from '../dtos/create-role.dto';
import slugify from 'slugify';
import { UpdateRoleDto } from '../dtos/update-role.dto';
import { FilterRolesDto } from '../dtos/filter-roles.dto';

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  

  async getRoleById(roleId: string, organizationId?: string) {
    const where: any = { id: roleId };
    if (organizationId) {
      where.organizationId = organizationId;
    }

    const role = await this.prisma.role.findFirst({
      where,
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }
    // Flatten: Return clean object to frontend/guards
    return {
      ...role,
      permissions: role.permissions.map((rp) => rp.permission),
    };
  }

  async findAllWithFilters(filters: FilterRolesDto) {
  const {
    scope,
    organizationId,
    search,
    includeSystem = true,
  } = filters;

  const where: any = {};

  if (scope) where.scope = scope;

  if (organizationId) {
    where.OR = [
      { organizationId },
      ...(includeSystem
        ? [{ isSystem: true, scope: RoleScope.ORGANIZATION }]
        : []),
    ];
  } else if (includeSystem === false) {
    where.isSystem = false;
  }

  // Search Filter
  if (search) {
    where.OR = [
      ...(where.OR || []),
      { name: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
    ];
  }

  const roles = await this.prisma.role.findMany({
    where,
    include: {
      permissions: { include: { permission: true } },
      _count: { select: { organizationMembers: true } },
    },
    orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
  });

  // Flatten for frontend & guards
  return roles.map((r) => ({
    ...r,
    permissions: r.permissions.map((rp) => rp.permission),
  }));
}


  async getRolesForOrganization(orgId: string) {
    // Fetch Custom Roles AND System Roles applicable to Orgs
    const roles = await this.prisma.role.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { isSystem: true, scope: RoleScope.ORGANIZATION },
        ],
      },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { organizationMembers: true } },
      },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });

    // Flatten for UI
    return roles.map((r) => ({
      ...r,
      permissions: r.permissions.map((rp) => rp.permission),
    }));
  }

  async create(dto: CreateRoleDto) {
    const exists = await this.prisma.role.findFirst({
      where: {
        name: dto.name,
        scope: dto.scope,
        organizationId:
          dto.scope === RoleScope.ORGANIZATION ? dto.organizationId : null,
      },
    });

    if (exists)
      throw new ConflictException('Role already exists in this scope');

    const slug = slugify(dto.name, { lower: true, strict: true });

    // 2. Create with Permissions
    const role = await this.prisma.role.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        description: dto.description,
        slug,
        scope: dto.scope,
        organizationId: dto.organizationId,
        isSystem: false,
        permissions: {
          create:
            dto.permissionIds?.map((pid) => ({ permissionId: pid })) || [],
        },
      },
      include: { permissions: { include: { permission: true } } },
    });

    return {
      ...role,
      permissions: role.permissions.map((rp) => rp.permission),
    };
  }

  async update(roleId: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem)
      throw new BadRequestException('Cannot modify System Roles');

    return this.prisma.$transaction(async (tx) => {
      if (dto.permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId } });

        if (dto.permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: dto.permissionIds.map((pid) => ({
              roleId,
              permissionId: pid,
            })),
          });
        }
      }

      // 2. Update basic info
      const updated = await tx.role.update({
        where: { id: roleId },
        data: {
          displayName: dto.displayName,
          description: dto.description,
        },
        include: { permissions: { include: { permission: true } } },
      });

      return {
        ...updated,
        permissions: updated.permissions.map((rp) => rp.permission),
      };
    });
  }

  async delete(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { organizationMembers: true } } },
    });

    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem)
      throw new BadRequestException('Cannot delete System Roles');

    // Safety Check: Don't delete if people are using it
    if (role._count.organizationMembers > 0) {
      throw new ConflictException('Cannot delete role assigned to members.');
    }

    await this.prisma.role.delete({ where: { id: roleId } });
  }


    async addPermissionsToRole(roleId: string, permissionIds: string[]) {
      const data = permissionIds.map((permissionId) => ({
        roleId,
        permissionId,
      }));
      return this.prisma.rolePermission.createMany({
        data,
        skipDuplicates: true,
      });
    }
  
    async removePermissionsFromRole(roleId: string, permissionIds: string[]) {
      return this.prisma.rolePermission.deleteMany({
        where: {
          roleId,
          permissionId: { in: permissionIds },
        },
      });
    }
  
    async getPermissionsForRole(roleId: string) {
      return this.prisma.rolePermission.findMany({
        where: { roleId },
        include: { permission: true },
      });
    }
}
