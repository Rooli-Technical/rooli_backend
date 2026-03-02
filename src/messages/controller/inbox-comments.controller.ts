import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import { InboxService } from '../services/inbox-message.service';
import { InboxCommentsService } from '../services/inbox-comments.service';
import { SendCommentReplyDto } from '../dtos/send-comment.dto';

@ApiTags('Comments')
@ApiBearerAuth()
@Controller('inbox/:workspaceId/posts')
export class InboxCommentsController {
  constructor(private readonly inboxService: InboxCommentsService) {}

  @Get()
  @ApiOperation({ summary: 'List posts that have comments' })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated posts with unread counts',
  })
  async listPostsWithComments(
    @Param('workspaceId') workspaceId: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.inboxService.listPostsWithComments({
      workspaceId,
      take: take ? parseInt(take, 10) : 25,
      cursor,
    });
  }

  @Get(':postId/comments')
  @ApiOperation({ summary: 'List all comments for a specific post' })
  @ApiResponse({ status: 200, description: 'Returns threaded comments' })
  async listComments(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    // You will need to add this method to your inboxService!
    return this.inboxService.listCommentsForPost({
      workspaceId,
      postId,
      take: take ? parseInt(take, 10) : 50,
      cursor,
    });
  }

  @Post('comments/:commentId/reply')
  @ApiOperation({ summary: 'Reply to a specific public comment' })
  @ApiResponse({ status: 201, description: 'Comment reply queued for sending' })
  async replyToComment(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') parentCommentId: string,
    @Body() body: SendCommentReplyDto,
  ) {
    return this.inboxService.sendCommentReply({
      workspaceId,
      parentCommentId,
      content: body.content,
    });
  }
}
