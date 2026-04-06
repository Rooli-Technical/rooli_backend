import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AddCommentDto,
  AssignTicketDto,
  AdminCreateTicketDto,
  QueryTicketsDto,
  UpdateTicketDto,
} from './support-ticket.dto';
import { TicketsService } from './support-ticket.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';
import { BypassSubscription } from '@/common/decorators/bypass-subscription.decorator';
import { AdminRoute } from '@/common/decorators/admin-route.decorator';

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('Admin-Tickets')
@ApiBearerAuth()
@AdminRoute()
@UseGuards(AdminJwtGuard)
@Controller('admin/support/tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  // Tickets ──────────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a support ticket' })
  @ApiResponse({ status: 201, description: 'Ticket created.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  create(
    @Body() dto: AdminCreateTicketDto,
    @CurrentUser('userId') requesterId: string,
  ) {
    return this.ticketsService.create(requesterId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List tickets with filters & pagination' })
  @ApiResponse({ status: 200, description: 'Paginated list of tickets.' })
  findAll(@Query() query: QueryTicketsDto) {
    return this.ticketsService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Ticket statistics (counts by status/priority)' })
  @ApiQuery({ name: 'workspaceId', required: false })
  @ApiResponse({ status: 200, description: 'Statistics object.' })
  getStats(@Query('workspaceId') workspaceId?: string) {
    return this.ticketsService.getStats(workspaceId);
  }

  @Get('by-number/:ticketNumber')
  @ApiOperation({ summary: 'Get ticket by human-readable number (e.g. #1041)' })
  @ApiParam({ name: 'ticketNumber', type: Number, example: 1041 })
  @ApiResponse({ status: 200, description: 'Ticket found.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  findByNumber(@Param('ticketNumber', ParseIntPipe) ticketNumber: number) {
    return this.ticketsService.findByTicketNumber(ticketNumber);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a ticket by ID' })
  @ApiParam({ name: 'id', example: 'clx1234abcd' })
  @ApiResponse({ status: 200, description: 'Ticket found.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  findOne(@Param('id') id: string) {
    return this.ticketsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a ticket (title, status, priority, assignee…)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Ticket updated.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  update(@Param('id') id: string, @Body() dto: UpdateTicketDto) {
    return this.ticketsService.update(id, dto);
  }

  @Patch(':id/assign')
  @ApiOperation({ summary: 'Assign ticket to a support agent' })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 200,
    description: 'Ticket assigned; status set to IN_PROGRESS.',
  })
  @ApiResponse({ status: 400, description: 'Cannot assign a closed ticket.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  assign(@Param('id') id: string, @Body() dto: AssignTicketDto) {
    return this.ticketsService.assign(id, dto);
  }

  @Patch(':id/close')
  @ApiOperation({ summary: 'Close a ticket' })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 200,
    description: 'Ticket closed; closedAt recorded.',
  })
  @ApiResponse({ status: 400, description: 'Ticket already closed.' })
  close(@Param('id') id: string) {
    return this.ticketsService.close(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a ticket (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 204, description: 'Ticket deleted.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  remove(@Param('id') id: string) {
    return this.ticketsService.remove(id);
  }

  // Comments ─────────────────────────────────────────────────────────────────

  @Post(':id/comments')
  @ApiOperation({ summary: 'Add a reply or internal note to a ticket' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Comment added.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  addComment(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: AddCommentDto,

    @CurrentUser('userId') requesterId: string,
  ) {
    const newDto = {
      isInternal: dto.isInternal,
      body: dto.body,
      mediaFiles: dto.mediaFileIds,
      authorId: requesterId,
    };
    return this.ticketsService.addComment(id, newDto);
  }

  @Get(':id/comments')
  @ApiOperation({ summary: 'Get all comments for a ticket' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'List of comments.' })
  getComments(@Param('id') id: string) {
    return this.ticketsService.getComments(id);
  }

  @Delete(':id/comments/:commentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a comment (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment deleted.' })
  deleteComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.ticketsService.deleteComment(id, commentId);
  }
}
