import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  Query, 
  Patch, 
  ParseUUIDPipe 
} from '@nestjs/common';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiParam, 
  ApiBearerAuth 
} from '@nestjs/swagger';
import { SupportTicketService } from './support-ticket.service';
import { CreateTicketDto, AddCommentDto } from './dtos/create-ticket.dto';
import { GetTicketsDto } from './dtos/get-tickets.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@ApiTags('Support Tickets')
@ApiBearerAuth()
@Controller(':workspaceId/tickets')
export class SupportTicketController {
  constructor(private readonly ticketService: SupportTicketService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new support ticket' })
  @ApiResponse({ status: 201, description: 'Ticket successfully created.' })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() createTicketDto: CreateTicketDto,
    @CurrentUser('userId') requesterId: string, 
  ) {
    return this.ticketService.createTicket(workspaceId, requesterId, createTicketDto);
  }

  @Get()
  @ApiOperation({ summary: 'List all tickets for the workspace' })
  @ApiResponse({ status: 200, description: 'Returns a paginated list of tickets.' })
  async findAll(
    @Param('workspaceId') workspaceId: string,
    @Query() query: GetTicketsDto,
  ) {
    return this.ticketService.getTickets(workspaceId, query);
  }

  @Get(':ticketId')
  @ApiOperation({ summary: 'Get detailed information about a specific ticket' })
  @ApiParam({ name: 'ticketId', description: 'The UUID of the ticket' })
  async findOne(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
  ) {
    return this.ticketService.getTicketDetails(workspaceId, ticketId);
  }

  @Post(':ticketId/comments')
  @ApiOperation({ summary: 'Add a comment to a ticket' })
  async addComment(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @CurrentUser('userId') requesterId: string, 
    @Body() addCommentDto: AddCommentDto,
  ) {
    return this.ticketService.addComment(workspaceId, ticketId, requesterId, addCommentDto);
  }

  @Patch(':ticketId/close')
  @ApiOperation({ summary: 'Close a ticket' })
  @ApiResponse({ status: 200, description: 'Ticket status updated to CLOSED.' })
  async closeTicket(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.ticketService.closeMyTicket(workspaceId, ticketId);
  }
}