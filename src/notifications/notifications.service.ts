import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DomainEventsService } from '../events/domain-events.service';
import { Prisma } from '@generated/client';
import {
  CreateNotificationInput,
  CreateManyNotificationsInput,
} from './types/notification.types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
  ) {}

  async create(input: CreateNotificationInput) {
    const row = await this.prisma.notification.create({
      data: {
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? undefined,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
      select: this.notificationSelect(),
    });
    this.events.emit('notification.created' as any, {
      workspaceId: row.workspaceId,
      memberId: row.memberId,
      notification: row,
    });

    return row;
  }

  /**
   * Bulk create notifications for many members.
   * - Uses createMany for speed
   * - Optional dedupe by (memberId, dedupeKey) if you enabled that unique constraint
   *
   * If you did NOT add dedupeKey uniqueness, set `skipDuplicates` to false.
   */
  async createMany(input: CreateManyNotificationsInput) {

    const now = new Date();

    const skipDuplicates = input.skipDuplicates ?? false;

    const notifications = await this.prisma.notification.createManyAndReturn({
      data: input.memberIds.map((memberId) => ({
        workspaceId: input.workspaceId,
        memberId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? undefined,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${memberId}` : null,
        readAt: null,
        createdAt: now,
      })),
      skipDuplicates,
    });

    // Emit lightweight events per member (don’t fetch all rows; not worth it).
    // Client can refetch list/unread count.
    for (const record of notifications) {
    this.events.emit('notification.created' as any, {
      workspaceId: record.workspaceId,
      memberId: record.memberId,
      notification: {
        id: record.id, 
        type: record.type,
        title: record.title,
        body: record.body,
        link: record.link,
        createdAt: record.createdAt,
      },
    });
  }

    return { ok: true, createdAt: now };
  }

  // =========================
  // READ / LIST
  // =========================

  async list(params: {
    workspaceId: string;
    memberId: string;
    limit: number; // Using 'limit' from PaginationDto
    cursor?: string;
    onlyUnread?: boolean;
  }) {
    const take = Math.min(params.limit ?? 20, 100);

    const cursor = params.cursor ? { id: params.cursor } : undefined;

    const where: Prisma.NotificationWhereInput = {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      ...(params.onlyUnread ? { readAt: null } : {}),
    };

    const rows = await this.prisma.notification.findMany({
      where,
      take,
      skip: cursor ? 1 : 0,
      cursor,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: this.notificationSelect(),
    });

    const nextCursor = rows.length === take ? rows[rows.length - 1].id : null;

    return {
      items: rows,
      meta: {
        nextCursor,
        hasMore: !!nextCursor,
        limit: take,
      },
    };
  }

  async unreadCount(params: { workspaceId: string; memberId: string }) {
    const count = await this.prisma.notification.count({
      where: {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        readAt: null,
      },
    });
    return { unreadCount: count };
  }

  // =========================
  // MARK READ
  // =========================

  async markRead(params: {
    workspaceId: string;
    memberId: string;
    notificationIds: string[];
  }) {
    if (!params.notificationIds.length) return { ok: true, updated: 0 };

    const now = new Date();
    const res = await this.prisma.notification.updateMany({
      where: {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        id: { in: params.notificationIds },
        readAt: null,
      },
      data: { readAt: now },
    });

    this.events.emit('notification.read' as any, {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      notificationIds: params.notificationIds,
      readAt: now,
    });

    return { ok: true, updated: res.count, readAt: now };
  }

  async markAllRead(params: { workspaceId: string; memberId: string }) {
    const now = new Date();
    const res = await this.prisma.notification.updateMany({
      where: {
        workspaceId: params.workspaceId,
        memberId: params.memberId,
        readAt: null,
      },
      data: { readAt: now },
    });

    this.events.emit('notification.read_all' as any, {
      workspaceId: params.workspaceId,
      memberId: params.memberId,
      readAt: now,
    });

    return { ok: true, updated: res.count, readAt: now };
  }

  async delete(params: {
    workspaceId: string;
    memberId: string;
    notificationId: string;
  }) {
    await this.prisma.notification.delete({
      where: {
        id: params.notificationId,
        memberId: params.memberId,
      },
    });
    return { ok: true };
  }

  // =========================
  // Helpers
  // =========================

  private notificationSelect() {
    return {
      id: true,
      workspaceId: true,
      memberId: true,
      type: true,
      title: true,
      body: true,
      data: true,
      link: true,
      readAt: true,
      createdAt: true,
    } satisfies Prisma.NotificationSelect;
  }
}

// =========================
// Types
// =========================
