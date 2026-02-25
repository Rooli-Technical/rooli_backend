import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ListConversationsDto } from './dtos/list-conversations.dto';
import { UpdateConversationDto } from './dtos/send-message.dto';
import { SendReplyDto } from './dtos/send-reply.dto';
import { InboxMessagesService } from './services/inbox-messages.service';
import { InboxService } from './services/inbox.service';


@ApiTags('Messages')
@ApiBearerAuth()
@Controller('messages/conversations/:workspaceId')
export class InboxController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly inboxMessagesService: InboxMessagesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List conversations' })
  @ApiResponse({ status: 200, description: 'Returns paginated conversations' })
  async listConversations(
    @Param('workspaceId') workspaceId: string,
    @Req() req: any, 
    @Query() query: ListConversationsDto,
  ) {
    const memberId = req.user?.userId; 
    
    // Convert "unassigned" string to actual null for the service
    const assignedMemberId = query.assignedMemberId === 'unassigned' ? null : query.assignedMemberId;

    return this.inboxService.listConversations({
      workspaceId,
      memberId,
      query: { ...query, assignedMemberId },
    });
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'Get a specific conversation' })
  @ApiResponse({ status: 200, description: 'Returns conversation details and contact info' })
  async getConversation(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.inboxService.getConversation({ workspaceId, conversationId });
  }

  @Get(':conversationId/messages')
  @ApiOperation({ summary: 'List messages in a conversation' })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Returns paginated messages' })
  async listMessages(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.inboxService.listMessages({
      workspaceId,
      conversationId,
      take: take ? parseInt(take, 10) : 50,
      cursor,
    });
  }

  @Patch(':conversationId')
  @ApiOperation({ summary: 'Update conversation metadata (Assign, Archive, Resolve)' })
  @ApiResponse({ status: 200, description: 'Conversation updated' })
  async updateConversation(
   @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Body() patch: UpdateConversationDto,
  ) {
    return this.inboxService.updateConversation({
      workspaceId,
      conversationId,
      patch,
    });
  }

  @Post(':conversationId/read')
  @ApiOperation({ summary: 'Mark conversation as read for current agent' })
  @ApiResponse({ status: 201, description: 'Read state updated' })
  async markRead(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: any,
  ) {
    const memberId = req.user?.userId;
    return this.inboxService.markRead({
      workspaceId,
      conversationId,
      memberId,
    });
  }

  @Post(':conversationId/messages')
  @ApiOperation({ summary: 'Send a reply to the customer' })
  @ApiResponse({ status: 201, description: 'Message queued for sending' })
  async sendReply(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: SendReplyDto,
  ) {

    return this.inboxMessagesService.sendReply({
      workspaceId,
      memberId: body.memberId,
      conversationId,
      content: body.content,
      attachments: body.attachments,
    });
  }
}