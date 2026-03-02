import { DomainEventsService } from "@/events/domain-events.service";
import { PrismaService } from "@/prisma/prisma.service";
import { Prisma } from "@generated/client";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { Queue } from "bullmq";


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
  constructor(private readonly prisma: PrismaService, private readonly events: DomainEventsService,
      @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,) {}

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

    /**
   * Agent reply:
   * - create OUTBOUND message with deliveryStatus=QUEUED
   * - enqueue job (jobId = outbound:<messageId>) so retries don't double-send
   * - emit events so UI shows "sending…" immediately
   */
  async sendReply(params: {
    workspaceId: string;
    memberId: string; // agent
    conversationId: string;
    content: string;
    attachments?: Array<{
      type: string; // AttachmentType
      url: string;
      proxyUrl?: string | null;
      thumbnailUrl?: string | null;
      mimeType?: string | null;
      fileSizeBytes?: number | null;
      meta?: any;
    }>;
  }) {
    try{
    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      include: { contact: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');


    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.inboxMessage.create({
        data: {
          conversationId: convo.id,
          clientMessageId: `msg_${now.getTime()}_${Math.random().toString(36).slice(2)}`,
          providerMessageId: null,
          content: params.content,
          direction: 'OUTBOUND' as any,
          deliveryStatus: 'QUEUED' as any,
          senderName: null,
          providerTimestamp: null,
          attachments: params.attachments?.length
            ? {
                create: params.attachments.map((a) => ({
                  type: a.type as any,
                  url: a.url,
                  proxyUrl: a.proxyUrl ?? null,
                  thumbnailUrl: a.thumbnailUrl ?? null,
                  mimeType: a.mimeType ?? null,
                  fileSizeBytes: a.fileSizeBytes ?? null,
                  meta: a.meta ?? undefined,
                })),
              }
            : undefined,
        },
        include: { attachments: true },
      });

      await tx.inboxConversation.update({
        where: { id: convo.id },
        data: {
          lastMessageAt: now,
          snippet: (params.content ?? '').slice(0, 140),
        },
      });

      // Mark agent read at send time (optional but nice)
      await tx.conversationReadState.upsert({
        where: {
          conversationId_memberId: {
            conversationId: convo.id,
            memberId: params.memberId,
          },
        },
        update: { lastReadAt: now },
        create: {
          conversationId: convo.id,
          memberId: params.memberId,
          lastReadAt: now,
        },
      });

      return msg;
    });

    await this.outboundQueue.add(
      'send-outbound-message',
      { messageId: created.id, memberId: params.memberId },
      {
        jobId: `outbound-${created.id}`,
        attempts: 15,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );

    // UI can show message bubble instantly
    this.events.emit('inbox.message.created', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: created.id,
      direction: 'OUTBOUND',
    });
    this.events.emit('inbox.conversation.updated', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      lastMessageAt: now,
      snippet: (params.content ?? '').slice(0, 140),
    });
    this.events.emit('inbox.message.status.updated', {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: created.id,
      deliveryStatus: 'QUEUED',
    });

    return created;
  } catch (error) {
    console.error( error);
    throw error
  }
  }
}

