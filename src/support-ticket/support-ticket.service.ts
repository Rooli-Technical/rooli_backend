import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    data: CreateTicketDto,
  ) {
    const ticket = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: { ticketCounter: { increment: 1 } },
        select: { ticketCounter: true },
      });

      // 2. Explicitly AWAIT the creation inside the transaction
      const newTicket = await tx.ticket.create({
        data: {
          workspaceId: workspaceId,
          requesterId,
          ticketNumber: workspace.ticketCounter,
          title: data.title,
          description: data.description,
          category: data.category,
          mediaFiles: data.mediaFileIds?.length
            ? { connect: data.mediaFileIds.map((id) => ({ id })) }
            : undefined,
          priority: data.priority ?? TicketPriority.MEDIUM,
        },
        include: {
          requester: {
            select: {
              member: {
                select: {
                  user: {
                    select: {
                      firstName: true,
                      lastName: true,
                    },
                  },
                },
              },
            },
          },
          mediaFiles: true,
        },
      });

      return newTicket;
    });

    // 3. Format the data for the event and response
    const requesterName = ticket.requester
      ? `${ticket.requester.member.user.firstName} ${ticket.requester.member.user.lastName}`.trim()
      : 'Unknown';

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

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      requesterName,
      createdAt: ticket.createdAt,
      mediaFiles: ticket.mediaFiles.map((file) => ({
        id: file.id,
        url: file.url,
        thumbnailUrl: file.thumbnailUrl,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
      })),
    };
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
          assignee: {
            select: { id: true, firstName: true, lastName: true, avatar: true },
          },
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

  async getTicketDetails(
    workspaceId: string,
    ticketId: string,
    isSupportAgent: boolean,
  ) {
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
        assignee: {
          select: { id: true, firstName: true, lastName: true, avatar: true },
        },
        mediaFiles: true,
        comments: {
          where: isSupportAgent ? undefined : { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                avatar: true,
              },
            },
            mediaFiles: true,
          },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket not found');

    const requesterName = ticket.requester
      ? `${ticket.requester.member.user.firstName} ${ticket.requester.member.user.lastName}`.trim()
      : 'Unknown';

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      category: ticket.category,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      closedAt: ticket.closedAt,

      // 👇 1. Flatten the Requester
      requester: ticket.requester
        ? {
            id: ticket.requester.id,
            name: requesterName,
            email: ticket.requester.member.user.email,
          }
        : null,

      // 👇 2. Clean up the Assignee (if an Admin claimed it)
      assignee: ticket.assignee
        ? {
            id: ticket.assignee.id,
            name: `${ticket.assignee.firstName} ${ticket.assignee.lastName}`.trim(),
            avatarUrl: ticket.assignee.avatar?.url || null, // Assuming avatar is related this way
          }
        : null,

      // 👇 3. Clean up the main Ticket Media Files
      mediaFiles: ticket.mediaFiles.map((file) => ({
        id: file.id,
        url: file.url,
        thumbnailUrl: file.thumbnailUrl,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
      })),

      // 👇 4. Clean up the Comments array and the Author Avatars
      comments: ticket.comments.map((comment) => ({
        id: comment.id,
        content: comment.content,
        isFromSupport: comment.isFromSupport,
        isInternal: comment.isInternal,
        createdAt: comment.createdAt,

        // Flatten the comment author
        author: {
          id: comment.author.id,
          name: `${comment.author.firstName} ${comment.author.lastName}`.trim(),
          avatarUrl: comment.author.avatar?.url || null,
        },

        // Clean up the comment media files
        mediaFiles: comment.mediaFiles.map((file) => ({
          id: file.id,
          url: file.url,
          thumbnailUrl: file.thumbnailUrl,
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.size,
        })),
      })),
    };
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
          mediaFiles: data.mediaFileIds?.length
            ? {
                connect: data.mediaFileIds.map((id) => ({ id })),
              }
            : undefined,
        },
        include: {
          author: {
            select: { id: true, firstName: true, lastName: true, avatar: true },
          },
          mediaFiles: true,
        },
      });

      await tx.ticket.update({
        where: { id: ticketId },
        data: { updatedAt: new Date() },
      });

      return {
        id: newComment.id,
        ticketId: newComment.ticketId,
        authorUserId: newComment.authorUserId,
        isFromSupport: newComment.isFromSupport,
        isInternal: newComment.isInternal,
        content: newComment.content,
        createdAt: newComment.createdAt,

        author: {
          id: newComment.author.id,
          firstName: newComment.author.firstName,
          lastName: newComment.author.lastName,
          avatarUrl: newComment.author.avatar?.url || null,
        },

        mediaFiles: newComment.mediaFiles.map((file) => ({
          id: file.id,
          url: file.url,
          thumbnailUrl: file.thumbnailUrl,
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.size,
        })),
      };
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

  async closeMyTicket(
    workspaceId: string,
    ticketId: string,
    requesterId: string,
  ) {
    try {
      const ticket = await this.prisma.ticket.update({
        where: { id: ticketId, workspaceId, requesterId },
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
      return {
        id: ticket.id,
        status: ticket.status,
        closedAt: ticket.closedAt,
        updatedAt: ticket.updatedAt,
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
      };
    } catch (error) {
      throw new BadRequestException('Failed to close ticket');
    }
  }
}
