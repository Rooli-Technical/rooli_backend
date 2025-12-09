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
}
