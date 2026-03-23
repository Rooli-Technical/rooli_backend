import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { paginate, PaginatedResult } from '../admin.common.dto';

export type UserStatusFilter = 'ALL' | 'ACTIVE' | 'SUSPENDED' | 'BANNED';

export interface AdminUserListItem {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  userType: string;
  lastActiveAt: Date | null;
  createdAt: Date;
  isEmailVerified: boolean;
  lockedUntil: Date | null;
  deletedAt: Date | null;
  workspaceCount: number;
}

export interface AdminUserListOptions {
  status?: UserStatusFilter;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
}

@Injectable()
export class AdminUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(
    options: AdminUserListOptions,
  ): Promise<PaginatedResult<AdminUserListItem>> {
    const { status = 'ALL', search, dateFrom, dateTo, page, limit } = options;
    const now = new Date();

    const statusWhere = {
      ALL: {},
      ACTIVE: { deletedAt: null, lockedUntil: null },
      SUSPENDED: { deletedAt: null, lockedUntil: { gte: now } },
      BANNED: { deletedAt: { not: null } },
    }[status];

    const searchWhere = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const dateWhere =
      dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateTo ? { lte: dateTo } : {}),
            },
          }
        : {};

    const where = { ...statusWhere, ...searchWhere, ...dateWhere };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id:true,
          firstName: true,
          lastName: true,
          email: true,
          userType: true,
          lastActiveAt: true,
          createdAt: true,
          isEmailVerified: true,
          lockedUntil: true,
          deletedAt: true,
          organizationMemberships: {
            select: {
              organization: {
                select: {
                  _count: { select: { workspaces: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const data: AdminUserListItem[] = users.map((user) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      userType: user.userType,
      lastActiveAt: user.lastActiveAt,
      createdAt: user.createdAt,
      isEmailVerified: user.isEmailVerified,
      lockedUntil: user.lockedUntil,
      deletedAt: user.deletedAt,
      workspaceCount: user.organizationMemberships.reduce(
        (sum, m) => sum + (m.organization?._count?.workspaces ?? 0),
        0,
      ),
    }));

    return paginate(data, total, page, limit);
  }

  async suspendUser(id: string, until?: Date) {
    const lockUntil = until ?? new Date('2099-12-31T23:59:59.999Z');
    return this.prisma.user.update({
      where: { id },
      data: {
        lockedUntil: lockUntil,
        refreshToken: null,
        refreshTokenVersion: { increment: 1 },
      },
      select: { lockedUntil: true },
    });
  }

  async reactivateUser(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: { lockedUntil: null, loginAttempts: 0, deletedAt: null },
      select: { lockedUntil: true, deletedAt: true },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, deletedAt: true, lockedUntil: true },
    });
  }
}
