import { PrismaService } from "@/prisma/prisma.service";
import { Prisma } from "@generated/client";
import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { ListInboxConversationsDto, UpdateConversationDto } from "../dtos/send-message.dto";


@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}


  async listConversations(params: {
    workspaceId: string;
    memberId: string;
    query: ListInboxConversationsDto;
  }) {
    const { workspaceId, memberId, query } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    const take = Math.min(query.limit ?? 20, 100);
    const skip = (Math.max(query.page ?? 1, 1) - 1) * take;

    const where: Prisma.InboxConversationWhereInput = {
      workspaceId,
      ...(query.socialProfileId ? { socialProfileId: query.socialProfileId } : {}),
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.priority ? { priority: query.priority as any } : {}),
      ...(query.assignedMemberId
        ? query.assignedMemberId === 'me'
          ? { assignedMemberId: memberId }
          : query.assignedMemberId === 'unassigned'
            ? { assignedMemberId: null }
            : { assignedMemberId: query.assignedMemberId }
        : {}),
      ...(query.search
        ? {
            OR: [
              { snippet: { contains: query.search, mode: 'insensitive' } },
              { contact: { username: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inboxConversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        take,
        skip,
        include: {
          contact: { select: { id: true, username: true, avatarUrl: true, platform: true } },
          assignedMember: { select: { id: true } },
        },
      }),
      this.prisma.inboxConversation.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page: query.page,
        limit: take,
        pages: Math.ceil(total / take),
      },
    };
  }

  async getConversation(params: { workspaceId: string; memberId: string; conversationId: string }) {
    const { workspaceId, memberId, conversationId } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: {
        contact: true,
        socialProfile: { select: { id: true } },
        assignedMember: { select: { id: true } },
      },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    return convo;
  }

  async updateConversation(params: {
    workspaceId: string;
    memberId: string;
    conversationId: string;
    dto: UpdateConversationDto;
  }) {
    const { workspaceId, memberId, conversationId, dto } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    // Ensure conversation belongs to workspace
    const exists = await this.prisma.inboxConversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Conversation not found');


    if (dto.assignedMemberId) {
      const assignee = await this.prisma.workspaceMember.findFirst({
        where: { id: dto.assignedMemberId, workspaceId },
        select: { id: true },
      });
      if (!assignee) throw new BadRequestException('Assignee not in workspace');
    }

    return this.prisma.inboxConversation.update({
      where: { id: conversationId },
      data: {
        ...(dto.status ? { status: dto.status as any } : {}),
        ...(dto.priority ? { priority: dto.priority as any } : {}),
        ...(dto.assignedMemberId !== undefined ? { assignedMemberId: dto.assignedMemberId } : {}),
        ...(dto.archivedAt !== undefined
          ? { archivedAt: dto.archivedAt ? new Date(dto.archivedAt) : null }
          : {}),
        ...(dto.snoozedUntil !== undefined
          ? { snoozedUntil: dto.snoozedUntil ? new Date(dto.snoozedUntil) : null }
          : {}),
      },
    });
  }

  async markRead(params: { workspaceId: string; memberId: string; conversationId: string }) {
    const { workspaceId, memberId, conversationId } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    const convo = await this.prisma.inboxConversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!convo) throw new NotFoundException('Conversation not found');

    await this.prisma.conversationReadState.upsert({
      where: { conversationId_memberId: { conversationId, memberId } },
      update: { lastReadAt: new Date() },
      create: { conversationId, memberId, lastReadAt: new Date() },
    });


    return { ok: true };
  }

  async computeUnreadCount(params: { workspaceId: string; memberId: string }) {
    const { workspaceId, memberId } = params;
    await this.assertWorkspaceMember(workspaceId, memberId);

    // Unread = conversations where lastMessageAt > lastReadAt OR no readState exists
    // Prisma can’t do this perfectly in one query across joins in all DBs.
    // Efficient compromise: fetch lastReadAt map for recently active conversations or use raw SQL.
    // Here’s a simple raw query for Postgres:
    const rows = await this.prisma.$queryRaw<
      Array<{ unread_count: bigint }>
    >(Prisma.sql`
      SELECT COUNT(*)::bigint AS unread_count
      FROM "InboxConversation" c
      LEFT JOIN "ConversationReadState" r
        ON r."conversationId" = c.id AND r."memberId" = ${memberId}
      WHERE c."workspaceId" = ${workspaceId}
        AND (r."lastReadAt" IS NULL OR c."lastMessageAt" > r."lastReadAt")
        AND c."archivedAt" IS NULL
        AND (c."snoozedUntil" IS NULL OR c."snoozedUntil" <= NOW())
    `);

    return Number(rows?.[0]?.unread_count ?? 0);
  }

    private async assertWorkspaceMember(workspaceId: string, memberId: string) {
    const m = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true },
    });
    if (!m) throw new ForbiddenException('Not a workspace member');
  }
}

