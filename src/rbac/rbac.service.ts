import { PrismaService } from '@/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

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
}
