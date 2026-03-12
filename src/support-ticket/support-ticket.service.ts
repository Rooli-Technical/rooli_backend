import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TicketPriority, TicketStatus } from '@generated/enums';
import { GetTicketsDto } from './dtos/get-tickets.dto';
import { AddCommentDto, CreateTicketDto } from './dtos/create-ticket.dto';
import { DomainEventsService } from '@/events/domain-events.service';

@Injectable()
export class SupportTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  async createTicket(
    workspaceId: string,
    requesterId: string,
    data:CreateTicketDto,
  ) {
    const ticket = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { ticketCounter: { increment: 1 } },
        select: { ticketCounter: true },
      });

      return tx.ticket.create({
        data: {
          workspaceId,
          requesterId,
          ticketNumber: workspace.ticketCounter,
          title: data.title,
          description: data.description,
          category: data.category,
          mediaFiles: data.mediaFileIds?.length
            ? {
                connect: data.mediaFileIds.map((id) => ({ id })),
              }
            : undefined,
          priority: data.priority ?? TicketPriority.MEDIUM,
        },
        include: {
          requester: {
        select: {
          id: true,
          member: {
            select: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
        },
      },
          mediaFiles: true,
        },
      });
    });

    const requesterName = ticket.requester ? `${ticket.requester.member.user.firstName} ${ticket.requester.member.user.lastName}`.trim() : 'Unknown';

    this.domainEvents.emit('ticket.created', {
      workspaceId,
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      priority: ticket.priority,
      status: ticket.status,
      requesterName,
      createdAt: ticket.createdAt,
    });
    return ticket;
  }

  async getTickets(workspaceId: string, query: GetTicketsDto) {
    const { page, limit, status, assigneeId } = query;
    const skip = (page - 1) * limit;

    const where = {
      workspaceId,
      ...(status && { status }),
      ...(assigneeId && { assigneeId }),
    };

    // Run count and fetch concurrently for performance
    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          requester: {
        select: {
          id: true,
          member: {
            select: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
        },
      },
          assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTicketDetails(workspaceId: string, ticketId: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: {
        requester: {
        select: {
          id: true,
          member: {
            select: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
        },
      },
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        mediaFiles: true,
        comments: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: {
            author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
            mediaFiles: true,
          },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async addComment(
    workspaceId: string,
    ticketId: string,
    authorUserId: string,
    data: AddCommentDto,
  ) {
    const ticketExists = await this.prisma.ticket.count({
      where: { id: ticketId, workspaceId },
    });
    if (!ticketExists) throw new NotFoundException('Ticket not found');

    const comment = await this.prisma.$transaction(async (tx) => {
      const newComment = await tx.ticketComment.create({
        data: {
          ticketId,
          authorUserId,
          content: data.content,
          isFromSupport: data.isFromSupport,
          isInternal: false, // Hardcoded false for users
          mediaFiles: data.mediaFileIds?.length ? {
            connect: data.mediaFileIds.map(id => ({ id }))
          } : undefined,
        },
        include: {
          author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          mediaFiles: true,
        },
      });

      await tx.ticket.update({
        where: { id: ticketId },
        data: { updatedAt: new Date() },
      });

      return newComment;
    });

    this.domainEvents.emit('ticket.comment.added', {
      workspaceId,
      ticketId,
      id: comment.id,
      content: comment.content,
      isFromSupport: comment.isFromSupport,
      isInternal: comment.isInternal,
      createdAt: comment.createdAt,
      author: {
        id: comment.author.id,
        name: `${comment.author.firstName} ${comment.author.lastName}`.trim(),
      },
      mediaFiles: comment.mediaFiles,
    });
    return comment;
  }

  async closeMyTicket(workspaceId: string, ticketId: string) {
    const ticket = await this.prisma.ticket.update({
      where: { id: ticketId, workspaceId },
      data: {
        status: TicketStatus.CLOSED,
        closedAt: new Date(),
      },
    });

   this.domainEvents.emit('ticket.updated', {
      workspaceId,
      ticketId: ticket.id,
      status: ticket.status,
      closedAt: ticket.closedAt,
    });
    return ticket;
  }
}
