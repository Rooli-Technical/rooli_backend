import { RealtimeEmitterService } from "@/events/realtime-emitter.service";
import { PrismaService } from "@/prisma/prisma.service";
import { TicketStatus, TicketCategory, TicketPriority } from "@generated/enums";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";


@Injectable()
export class AdminTicketsService {
  private readonly logger = new Logger(AdminTicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeEmitterService,
  ) {}

  // ============================================================================
  // 1. GLOBAL TICKET QUEUE (The Admin Dashboard)
  // ============================================================================
  async getAllTickets(filters?: {
    status?: TicketStatus;
    category?: TicketCategory;
    assigneeId?: string; // e.g., "Show me tickets assigned to ME"
    unassigned?: boolean; // e.g., "Show me new tickets nobody has claimed"
    workspaceId?: string;
  }) {
    return this.prisma.ticket.findMany({
      where: {
        ...(filters?.status && { status: filters.status }),
        ...(filters?.category && { category: filters.category }),
        ...(filters?.assigneeId && { assigneeId: filters.assigneeId }),
        ...(filters?.unassigned && { assigneeId: null }),
        ...(filters?.workspaceId && { workspaceId: filters.workspaceId }),
      },
      orderBy: [
        { priority: 'desc' }, // URGENT tickets at the top
        { updatedAt: 'desc' }, // Then sort by most recently active
      ],
      include: {
        workspace: { select: { id: true, name: true } }, 
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
        assignee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  // ============================================================================
  // 2. GET TICKET DETAILS (God Mode View)
  // ============================================================================
  async getTicketDetails(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        workspace: { select: { id: true, name: true } },
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

  // ============================================================================
  // 3. CLAIM A TICKET (Assign to yourself or another Admin)
  // ============================================================================
  async assignTicket(ticketId: string, adminUserId: string) {
    // We update the ticket AND change the status to IN_PROGRESS simultaneously
    const ticket = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        assigneeId: adminUserId,
        status: TicketStatus.IN_PROGRESS,
      },
      include: {
        assignee: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // 📢 Real-time Broadcast: Tell the customer's workspace that an admin is looking at it!
    this.emitter.emitToWorkspace(ticket.workspaceId, 'ticket.updated', ticket);

    return ticket;
  }

  // ============================================================================
  // 4. UPDATE TICKET STATUS (Resolve or escalate)
  // ============================================================================
  async updateTicketStatus(ticketId: string, status: TicketStatus, priority?: TicketPriority) {
    const isClosing = status === TicketStatus.RESOLVED || status === TicketStatus.CLOSED;

    const ticket = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status,
        ...(priority && { priority }),
        closedAt: isClosing ? new Date() : null,
      },
    });

    // 📢 Real-time Broadcast
    this.emitter.emitToWorkspace(ticket.workspaceId, 'ticket.updated', ticket);

    return ticket;
  }

  // ============================================================================
  // 5. ADD SUPPORT COMMENT (Public Reply or Internal Note)
  // ============================================================================
  async addAdminComment(ticketId: string, adminUserId: string, data: {
    content: string;
    isInternal: boolean; // TRUE for secret admin notes, FALSE to reply to the customer
  }) {
    // Fetch the ticket first so we know which workspace to broadcast to
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, workspaceId: true },
    });
    
    if (!ticket) throw new NotFoundException('Ticket not found');

    const comment = await this.prisma.$transaction(async (tx) => {
      // 1. Create the comment from the Super Admin
      const newComment = await tx.ticketComment.create({
        data: {
          ticketId,
          authorUserId: adminUserId,
          content: data.content,
          isFromSupport: true, // ✅ Always true because it's the Admin Service
          isInternal: data.isInternal,
        },
        include: {
          author: { select: { id: true, firstName: true, lastName: true ,avatar: true } },
        },
      });

      // 2. Bump the parent ticket's updatedAt time
      await tx.ticket.update({
        where: { id: ticketId },
        data: { updatedAt: new Date() },
      });

      return newComment;
    });

    // 📢 Real-time Broadcast to the conversation room
    // The frontend must check `isInternal` before rendering it!
    this.emitter.emitToConversation(ticket.workspaceId, ticketId, 'ticket.comment.added', comment);

    // Optional: Send a notification to the customer if it's NOT an internal note
    if (!data.isInternal) {
      // You could trigger your NotificationsService here to drop a bell icon for the customer
      // this.notifications.create({ type: 'TICKET_REPLY', ... })
    }

    return comment;
  }

    async updateTicket(workspaceId: string, ticketId: string, data: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeId?: string;
  }) {
    let closedAtValue: Date | null | undefined = undefined;

    // REOPEN BUG FIXED: Clear closedAt if it moves back to OPEN/IN_PROGRESS
    if (data.status) {
      const isClosing = data.status === TicketStatus.RESOLVED || data.status === TicketStatus.CLOSED;
      closedAtValue = isClosing ? new Date() : null; 
    }

    const ticket = await this.prisma.ticket.update({
      where: { id: ticketId, workspaceId },
      data: {
        ...data,
        closedAt: closedAtValue,
      },
      include: {
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    this.emitter.emitToWorkspace(workspaceId, 'ticket.updated', ticket);
    return ticket;
  }
}
