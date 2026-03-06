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

  @Get(':postId/comments')
  @ApiOperation({ summary: 'List all comments for a specific post' })
  @ApiResponse({ status: 200, description: 'Returns threaded comments' })
  async listComments(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
  ) {
    return this.inboxService.listCommentsForPost({
      workspaceId,
      postId,
    });
  }

  @Post(':postId/comments/:commentId/reply')
  @ApiOperation({ summary: 'Reply to a specific public comment' })
  @ApiResponse({ status: 201, description: 'Comment reply queued for sending' })
  async replyToComment(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
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
