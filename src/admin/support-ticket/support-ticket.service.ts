import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';;
import { TicketsRepository } from './support-ticket.repository';
import { AddCommentDto, AssignTicketDto, CreateTicketDto, QueryTicketsDto, UpdateTicketDto } from './support-ticket.dto';
import { TicketStatus } from '@generated/enums';
import { DomainEventsService } from '@/events/domain-events.service';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class TicketsService {
  constructor(private readonly repo: TicketsRepository,
    private readonly domainEvents: DomainEventsService,
    private readonly prisma: PrismaService,

  ) {}

  // Tickets ──────────────────────────────────────────────────────────────────

  create(dto: CreateTicketDto) {
    return this.repo.create(dto);
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
    if (!ticket) throw new NotFoundException(`Ticket #${ticketNumber} not found`);
    return ticket;
  }

  async update(id: string, dto: UpdateTicketDto) {
    await this.findOne(id);
    return this.repo.update(id, dto);
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

  async addComment(ticketId: string, dto: AddCommentDto) {

    await this.findOne(ticketId);
    const comment =  await this.repo.addComment(ticketId, dto);
    const getTicket = await this.prisma.ticket.findFirst({
      where:{
        id:comment.ticketId
      }
    })
    const ticketOwner = await this.prisma.user.findFirst(({
      where:{
        id: getTicket.requesterId
      }
    }))
    if(getTicket){

      this.domainEvents.emit('ticket.comment.added', {
        workspaceId:getTicket.workspaceId,
        ticketId,
        id: comment.id,
        content: comment.content,
        isFromSupport: comment.isFromSupport,
        isInternal: comment.isInternal,
        createdAt: comment.createdAt,
        mediaFiles: comment.mediaFiles,
        author: {
          id: comment.author.id,
          name: `${comment.author.firstName} ${comment.author.lastName}`.trim(),
        },
        email:ticketOwner?.email
      });
    }

    return comment
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