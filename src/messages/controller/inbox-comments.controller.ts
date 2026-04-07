import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { InboxCommentsService } from '../services/inbox-comments.service';
import { SendCommentReplyDto } from '../dtos/send-comment.dto';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionResource, PermissionAction } from '@/common/constants/rbac';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';

@ApiTags('Comments')
@ApiBearerAuth()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('workspaces/:workspaceId/inbox/comments')
export class InboxCommentsController {
  constructor(private readonly inboxService: InboxCommentsService) {}

  @Get('/post/:platformPostId')
  @RequirePermission(PermissionResource.COMMENTS, PermissionAction.READ)
  @ApiOperation({ summary: 'List all comments for a specific post' })
  @ApiResponse({ status: 200, description: 'Returns threaded comments' })
  async listComments(
    @Param('workspaceId') workspaceId: string,
    @Param('platformPostId') platformPostId: string,
  ) {
    return this.inboxService.listCommentsForPost({
      workspaceId,
      platformPostId,
    });
  }

  @Post(':commentId/reply')
  @RequirePermission(PermissionResource.COMMENTS, PermissionAction.CREATE)
  @ApiOperation({ summary: 'Reply to a specific public comment' })
  @ApiResponse({ status: 201, description: 'Comment reply queued for sending' })
  async replyToComment(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') parentCommentId: string,
    @Body() body: SendCommentReplyDto,
    @CurrentUser('workspaceMemberId') memberId: string,
  ) {
    return this.inboxService.sendCommentReply({
      workspaceId,
      parentCommentId,
      content: body.content,
      memberId,
    });
  }

  @Post(':commentId/retry')
  @ApiOperation({ summary: 'Retry sending a comment reply' })
  async retrySendingComment(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') parentCommentId: string,
  ) {
    return this.inboxService.retryCommentReply(workspaceId, parentCommentId);
  }
}
