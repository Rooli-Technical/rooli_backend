import { PrismaService } from "@/prisma/prisma.service";
import { Prisma } from "@generated/client";
import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";


type ListConversationsQuery = {
  search?: string;
  status?: string; // ConversationStatus
  assignedMemberId?: string | null;
  isArchived?: boolean;
  take?: number;
  cursor?: string; // cursor by lastMessageAt+id via composite? We'll do id cursor fallback
};

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inbox list for UI.
   * - fast: uses indexes on (workspaceId,lastMessageAt) and optional filters
   * - cursor paging by lastMessageAt + id (stable ordering)
   */
  async listConversations(params: {
    workspaceId: string;
    memberId: string; // current agent (WorkspaceMember id) for read state join
    query?: ListConversationsQuery;
  }) {
    const { workspaceId, memberId, query } = params;

    const take = Math.min(query?.take ?? 25, 100);

    const where: Prisma.InboxConversationWhereInput = {
      workspaceId,
      ...(query?.status ? { status: query.status as any } : {}),
      ...(query?.assignedMemberId === null
        ? { assignedMemberId: null }
        : query?.assignedMemberId
          ? { assignedMemberId: query.assignedMemberId }
          : {}),
      ...(query?.isArchived === true ? { archivedAt: { not: null } } : {}),
      ...(query?.isArchived === false ? { archivedAt: null } : {}),
      ...(query?.search
        ? {
            OR: [
              { snippet: { contains: query.search, mode: 'insensitive' } },
              { contact: { username: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    // Stable ordering for inbox list
    const orderBy: Prisma.InboxConversationOrderByWithRelationInput[] = [
      { lastMessageAt: 'desc' },
      { id: 'desc' },
    ];

    // Cursor (simple): use conversation id cursor (works, but not perfect for lastMessageAt ordering)
    // If you want perfect cursor, store a composite cursor field. This is acceptable for MVP.
    const cursor = query?.cursor ? { id: query.cursor } : undefined;
    const skip = cursor ? 1 : 0;

    const rows = await this.prisma.inboxConversation.findMany({
      where,
      take,
      skip,
      cursor,
      orderBy,
      include: {
        contact: true,
        assignedMember: { select: { id: true } },
        readStates: {
          where: { memberId },
          select: { lastReadAt: true },
        },
        _count: { select: { messages: true } },
      },
    });

    console.dir(rows, {depth: null})

    const items = rows.map((c) => {
     const lastReadAt = c.readStates[0]?.lastReadAt ?? null;
      const isRead = !!lastReadAt && lastReadAt >= c.lastMessageAt;

      return {
        id: c.id,
        workspaceId: c.workspaceId,
        socialProfileId: c.socialProfileId,
        externalId: c.externalId,
        status: c.status,
        priority: c.priority,
        assignedMemberId: c.assignedMemberId,
        archivedAt: c.archivedAt,
        snoozedUntil: c.snoozedUntil,
        lastMessageAt: c.lastMessageAt,
        snippet: c.snippet,
        contact: {
          id: c.contact.id,
          username: c.contact.username,
          avatarUrl: c.contact.avatarUrl,
          platform: c.contact.platform,
          externalId: c.contact.externalId,
        },
        isRead,
        messageCount: c._count.messages,
      };
    });

    const nextCursor = items.length === take ? items[items.length - 1].id : null;

    return { items, nextCursor };
  }

  async getConversation(params: { workspaceId: string; conversationId: string }) {
    const c = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      include: {
        contact: true,
        assignedMember: { select: { id: true } },
      },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    return c;
  }

  async listMessages(params: {
    workspaceId: string;
    conversationId: string;
    take?: number;
    cursor?: string; // message id cursor
  }) {
    const take = Math.min(params.take ?? 50, 200);

    // Ensure tenant safety
    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');

    const cursor = params.cursor ? { id: params.cursor } : undefined;
    const skip = cursor ? 1 : 0;

    const rows = await this.prisma.inboxMessage.findMany({
      where: { conversationId: params.conversationId },
      take,
      skip,
      cursor,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { attachments: true },
    });

    const nextCursor = rows.length === take ? rows[rows.length - 1].id : null;
    return { items: rows, nextCursor };
  }

  async updateConversation(params: {
    workspaceId: string;
    conversationId: string;
    patch: {
      status?: string;
      priority?: string;
      assignedMemberId?: string | null;
      archived?: boolean;
      snoozedUntil?: string | null;
    };
  }) {
      const _snoozedUntil = params.patch.snoozedUntil ? new Date(params.patch.snoozedUntil) : null;
    // tenant check
    const existing = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Conversation not found');

    const data: Prisma.InboxConversationUpdateInput = {};

    if (params.patch.status) data.status = params.patch.status as any;
    if (params.patch.priority) data.priority = params.patch.priority as any;
    if (params.patch.assignedMemberId !== undefined) {
  data.assignedMember = params.patch.assignedMemberId
    ? { connect: { id: params.patch.assignedMemberId } }
    : { disconnect: true };}
    if (params.patch.archived !== undefined)
      data.archivedAt = params.patch.archived ? new Date() : null;
    if (params.patch.snoozedUntil !== undefined)
      data.snoozedUntil = _snoozedUntil;
    return this.prisma.inboxConversation.update({
      where: { id: params.conversationId },
      data,
    });
  }

  /**
   * Per-agent read state.
   * This is what powers "unread" for each agent.
   */
  async markRead(params: {
    workspaceId: string;
    conversationId: string;
    memberId: string; // WorkspaceMember id
    readAt?: Date;
  }) {
    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      select: { id: true, lastMessageAt: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');

    const readAt = params.readAt ?? new Date();

    await this.prisma.conversationReadState.upsert({
      where: {
        conversationId_memberId: {
          conversationId: params.conversationId,
          memberId: params.memberId,
        },
      },
      update: { lastReadAt: readAt },
      create: {
        conversationId: params.conversationId,
        memberId: params.memberId,
        lastReadAt: readAt,
      },
    });

    return { ok: true };
  }
}

