import { PrismaService } from '@/prisma/prisma.service';
import { Permission } from '@generated/client';
import {
  PermissionScope,
  PermissionResource,
  PermissionAction,
} from '@generated/enums';
import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CreatePermissionDto } from '../dtos/create-permission.dto';
import { RedisService } from '@/redis/redis.service';

export const SYSTEM_PERMISSIONS = [
  // --- SYSTEM SCOPE ---
  {
    name: 'Manage System',
    scope: PermissionScope.SYSTEM,
    resource: PermissionResource.SYSTEM,
    action: PermissionAction.MANAGE,
  },

  // --- ORGANIZATION SCOPE ---
  {
    name: 'Manage Organization',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.ORGANIZATION,
    action: PermissionAction.MANAGE,
  },
  {
    name: 'Update Settings',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.SETTINGS,
    action: PermissionAction.UPDATE,
  },
  {
    name: 'Manage Billing',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.BILLING,
    action: PermissionAction.MANAGE,
  },

  // Member Management
  {
    name: 'Invite Members',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.MEMBERS,
    action: PermissionAction.CREATE,
  },
  {
    name: 'Manage Members',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.MEMBERS,
    action: PermissionAction.MANAGE,
  },
  {
    name: 'View Members',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.MEMBERS,
    action: PermissionAction.READ,
  },

  // Integrations
  {
    name: 'Manage Integrations',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.INTEGRATION,
    action: PermissionAction.MANAGE,
  },

  // --- SOCIAL ACCOUNT SCOPE (Roles assigned per social account) ---
  // Posts
  {
    name: 'Create Posts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.POSTS,
    action: PermissionAction.CREATE,
  },
  {
    name: 'Publish Posts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.POSTS,
    action: PermissionAction.PUBLISH,
  },
  {
    name: 'Delete Posts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.POSTS,
    action: PermissionAction.DELETE,
  },
  {
    name: 'View Posts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.POSTS,
    action: PermissionAction.READ,
  },

  // Drafts & Approvals
  {
    name: 'Create Drafts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.DRAFT,
    action: PermissionAction.CREATE,
  },
  {
    name: 'Approve Drafts',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.DRAFT,
    action: PermissionAction.APPROVE,
  },

  // Analytics
  {
    name: 'View Analytics',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.ANALYTICS,
    action: PermissionAction.READ,
  },

  // Messages/Comments
  {
    name: 'Manage Messages',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.MESSAGE,
    action: PermissionAction.MANAGE,
  },
  {
    name: 'Manage Comments',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.COMMENT,
    action: PermissionAction.MANAGE,
  },

  {
    name: 'Generate AI Content',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.AI_CONTENT,
    action: PermissionAction.CREATE,
  },
  {
    name: 'Manage AI Usage',
    scope: PermissionScope.ORGANIZATION,
    resource: PermissionResource.AI_USAGE,
    action: PermissionAction.MANAGE,
  },
  {
    name: 'Manage Content Templates',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.TEMPLATE,
    action: PermissionAction.MANAGE,
  },

  // --- SCHEDULING ---
  {
    name: 'Manage Schedule',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.SCHEDULE,
    action: PermissionAction.MANAGE,
  },
  {
    name: 'View Calendar',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.CALENDAR,
    action: PermissionAction.READ,
  },

  // --- INBOX & ENGAGEMENT ---
  {
    name: 'View Inbox',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.INBOX,
    action: PermissionAction.READ,
  },
  {
    name: 'Reply to Messages',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.MESSAGE,
    action: PermissionAction.CREATE,
  },
  {
    name: 'Delete Comments',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.COMMENT,
    action: PermissionAction.DELETE,
  },

  // --- ANALYTICS ---
  {
    name: 'Export Analytics',
    scope: PermissionScope.SOCIAL_ACCOUNT,
    resource: PermissionResource.ANALYTICS,
    action: PermissionAction.EXPORT,
  },
];

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      orderBy: [{ scope: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findByScope(scope: PermissionScope): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      where: { scope },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findByResource(
    scope: PermissionScope,
    resource: PermissionResource,
  ): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      where: { scope, resource },
      orderBy: { action: 'asc' },
    });
  }

  async findById(id: string): Promise<Permission> {
    const permission = await this.prisma.permission.findUnique({
      where: { id },
    });
    if (!permission) throw new NotFoundException('Permission not found');
    return permission;
  }

  async create(dto: CreatePermissionDto): Promise<Permission> {
    const existing = await this.prisma.permission.findFirst({
      where: {
        scope: dto.scope,
        resource: dto.resource,
        action: dto.action,
      },
    });

    if (existing) throw new ConflictException('Permission already exists');

    return this.prisma.permission.create({ data: dto });
  }

  async delete(id: string): Promise<void> {
    // Safety check still needed
    const count = await this.prisma.rolePermission.count({
      where: { permissionId: id },
    });
    if (count > 0)
      throw new ConflictException('Cannot delete permission assigned to roles');

    await this.prisma.permission.delete({ where: { id } });
  }

  async seedPermissions(): Promise<void> {
    this.logger.log('Seeding permissions...');
    const operations = SYSTEM_PERMISSIONS.map((p) =>
      this.prisma.permission.upsert({
        where: {
          scope_resource_action: {
            scope: p.scope,
            resource: p.resource,
            action: p.action,
          },
        },
        update: {},
        create: {
          name: p.name,
          description: `System permission for ${p.resource} ${p.action}`,
          scope: p.scope,
          resource: p.resource,
          action: p.action,
        },
      }),
    );

    await this.prisma.$transaction(operations);

    this.logger.log('Permissions seeding complete.');
  }
}
