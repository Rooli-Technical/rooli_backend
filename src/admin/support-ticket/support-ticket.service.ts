import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TicketsRepository } from './support-ticket.repository';
import {
  AdminAddCommentDto,
  AssignTicketDto,
  AdminCreateTicketDto,
  QueryTicketsDto,
  UpdateTicketDto,
} from './support-ticket.dto';
import { TicketStatus } from '@generated/enums';
import { DomainEventsService } from '@/events/domain-events.service';
import { PrismaService } from '@/prisma/prisma.service';
import { emit } from 'process';

@Injectable()
export class TicketsService {
  constructor(
    private readonly repo: TicketsRepository,
    private readonly domainEvents: DomainEventsService,
    private readonly prisma: PrismaService,
  ) {}

  // Tickets ──────────────────────────────────────────────────────────────────

  async create(requesterId: string, dto: AdminCreateTicketDto) {
    // return this.repo.create(requesterId,dto);
    const member = await this.prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: dto.workspaceId },
    });

    return this.repo.create(member.id, dto);
  }

  async findAll(query: QueryTicketsDto) {
    const { data, total, page, limit } = await this.repo.findAll(query);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const ticket = await this.repo.findById(id);
    if (!ticket) throw new NotFoundException(`Ticket "${id}" not found`);
    return ticket;
  }

  async findByTicketNumber(ticketNumber: number) {
    const ticket = await this.repo.findByTicketNumber(ticketNumber);
    if (!ticket)
      throw new NotFoundException(`Ticket #${ticketNumber} not found`);
    return ticket;
  }

  async update(id: string, dto: UpdateTicketDto) {
    const res = await this.repo.update(id, dto);
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: id },
      include: {
        requester: {
          include: {
            member: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    const ticketOwner = ticket.requester?.member?.user;
    const eventPayload = {
      workspaceId: ticket.workspaceId,
      ticketId: id,
      status: res.status,
      assigneeId: ticket.assigneeId,
      priority: ticket.priority,
      closedAt: ticket.closedAt,
      email: ticketOwner?.email,
    };

    if (
      (res.status === TicketStatus.CLOSED &&
        dto.status === TicketStatus.CLOSED) ||
      (res.status === TicketStatus.RESOLVED &&
        dto.status === TicketStatus.RESOLVED)
    ) {
      eventPayload['closedAt'] = res.closedAt;
      this.domainEvents.emit('ticket.updated', eventPayload);
    }

    return res;
  }

  async assign(id: string, dto: AssignTicketDto) {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CLOSED)
      throw new BadRequestException('Cannot assign a closed ticket');
    return this.repo.assign(id, dto.assigneeId);
  }

  async close(id: string) {
    const ticket = await this.findOne(id);
    if (ticket.status === TicketStatus.CLOSED)
      throw new BadRequestException('Ticket is already closed');
    return this.repo.close(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.repo.delete(id);
    return { message: `Ticket ${id} deleted` };
  }

  // Comments ─────────────────────────────────────────────────────────────────

  async addComment(ticketId: string, dto: any) {
    const comment = await this.repo.addComment(ticketId, dto);

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: comment.ticketId },
      include: {
        requester: {
          include: {
            member: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    const ticketOwner = ticket.requester?.member?.user;

    const authorName =
      `${comment.author.firstName} ${comment.author.lastName}`.trim();

    const eventPayload = {
      workspaceId: ticket.workspaceId,
      ticketId,
      id: comment.id,
      content: comment.content,
      isFromSupport: comment.isFromSupport,
      isInternal: comment.isInternal,
      createdAt: comment.createdAt,
      mediaFiles: comment.mediaFiles,
      author: {
        id: comment.author.id,
        name: authorName,
      },
    };
    console.log('🔥 BEFORE EMIT');

    this.domainEvents.emit('ticket.comment.added', eventPayload);

    this.domainEvents.emit('ticket.comment.reply', {
      ...eventPayload,
      email: ticketOwner?.email,
    });
    console.log('🔥 AFTER EMIT');

    return { commentId: comment.id };
  }

  async getComments(ticketId: string) {
    await this.findOne(ticketId);
    return this.repo.getComments(ticketId);
  }

  async deleteComment(ticketId: string, commentId: string) {
    await this.findOne(ticketId);
    return this.repo.deleteComment(commentId);
  }

  // Stats ────────────────────────────────────────────────────────────────────

  getStats(workspaceId?: string) {
    return this.repo.getStats(workspaceId);
  }
}
