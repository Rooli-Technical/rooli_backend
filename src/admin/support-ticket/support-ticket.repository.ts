import { Injectable } from '@nestjs/common';
import {
  AddCommentDto,
  CreateTicketDto,
  QueryTicketsDto,
  UpdateTicketDto,
} from './support-ticket.dto';
import { Prisma, TicketStatus } from '@generated/client';
import { PrismaService } from '@/prisma/prisma.service';

// ─── Include ──────────────────────────────────────────────────────────────────
// Mirrors the Ticket schema exactly:
//   requester  → WorkspaceMember  (flat — no nested user relation on WorkspaceMember)
//   assignee   → User?
//   workspace  → Workspace
//   comments   → TicketComment[]  with author: User
//   mediaFiles → MediaFile[]

const TICKET_INCLUDE = {
  requester: true,
  assignee: {
    select: {
      firstName: true,
      lastName: true,
    },
  },
  workspace: true,
  comments: {
    orderBy: { createdAt: Prisma.SortOrder.asc },
    include: {
      author: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  },
  mediaFiles: true,
} satisfies Prisma.TicketInclude;
// ─── Repository ───────────────────────────────────────────────────────────────

@Injectable()
export class TicketsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Tickets ──────────────────────────────────────────────────────────────────

  create(requesterId: string, dto: CreateTicketDto) {
    return this.prisma.ticket.create({
      data: {
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
        category: dto.category,
        workspace: { connect: { id: dto.workspaceId } },
        requester: { connect: { id: requesterId } },
      },
      include: TICKET_INCLUDE,
    });
  }

  async findAll(query: QueryTicketsDto) {
    const {
      page = 1,
      limit = 20,
      search,
      workspaceId,
      status,
      priority,
      category,
      assigneeId,
    } = query;

    const where: Prisma.TicketWhereInput = {
      ...(workspaceId && { workspaceId }),
      ...(status && { status }),
      ...(priority && { priority }),
      ...(category && { category }),
      ...(assigneeId && { assigneeId }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: Prisma.QueryMode.insensitive } },
          {
            description: {
              contains: search,
              mode: Prisma.QueryMode.insensitive,
            },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: Prisma.SortOrder.desc },
        include: TICKET_INCLUDE,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  findById(id: string) {
    return this.prisma.ticket.findUnique({
      where: { id },
      include: TICKET_INCLUDE,
    });
  }

  findByTicketNumber(ticketNumber: number) {
    return this.prisma.ticket.findUnique({
      where: { ticketNumber },
      include: TICKET_INCLUDE,
    });
  }

  update(id: string, dto: UpdateTicketDto) {
    const closedStatuses: TicketStatus[] = [
      TicketStatus.CLOSED,
      TicketStatus.RESOLVED,
    ];

    return this.prisma.ticket.update({
      where: { id },
      data: {
        ...(dto.title && { title: dto.title }),
        ...(dto.description && { description: dto.description }),
        ...(dto.status && { status: dto.status }),
        ...(dto.priority && { priority: dto.priority }),
        ...(dto.category && { category: dto.category }),
        // assigneeId can be explicitly null to unassign
        ...(dto.assigneeId !== undefined && {
          assignee: dto.assigneeId
            ? { connect: { id: dto.assigneeId } }
            : { disconnect: true },
        }),
        ...(dto.status &&
          closedStatuses.includes(dto.status) && { closedAt: new Date() }),
      },
      include: TICKET_INCLUDE,
    });
  }

  assign(id: string, assigneeId: string) {
    return this.prisma.ticket.update({
      where: { id },
      data: {
        assignee: { connect: { id: assigneeId } },
        status: TicketStatus.IN_PROGRESS,
      },
      include: TICKET_INCLUDE,
    });
  }

  close(id: string) {
    return this.prisma.ticket.update({
      where: { id },
      data: { status: TicketStatus.CLOSED, closedAt: new Date() },
      include: TICKET_INCLUDE,
    });
  }

  delete(id: string) {
    return this.prisma.ticket.delete({ where: { id } });
  }

  // Comments ─────────────────────────────────────────────────────────────────

  addComment(ticketId: string, dto: any) {
    return this.prisma.ticketComment.create({
      data: {
        content: dto.body,
        isInternal: dto.isInternal ?? false,
        ticket: { connect: { id: ticketId } },
        author: { connect: { id: dto.authorId } },
        isFromSupport: true,
        mediaFiles: dto.mediaFiles
          ? {
              connect: dto.mediaFiles.map((fileId: string) => ({ id: fileId })),
            }
          : undefined,
      },
      include: { author: true, mediaFiles: true },
    });
  }

  getComments(ticketId: string) {
    return this.prisma.ticketComment.findMany({
      where: { ticketId },
      orderBy: { createdAt: Prisma.SortOrder.asc },
      include: {
        author: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });
  }

  deleteComment(commentId: string) {
    return this.prisma.ticketComment.delete({ where: { id: commentId } });
  }

  // Stats ────────────────────────────────────────────────────────────────────

  async getStats(workspaceId?: string) {
    const where: Prisma.TicketWhereInput = workspaceId ? { workspaceId } : {};

    const [total, byStatus, byPriority] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.groupBy({ by: ['status'], where, _count: true }),
      this.prisma.ticket.groupBy({ by: ['priority'], where, _count: true }),
    ]);

    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      byPriority: Object.fromEntries(
        byPriority.map((p) => [p.priority, p._count]),
      ),
    };
  }
}
