
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/**
 * Assumptions (match your current architecture):
 * - You have an auth guard that sets req.user
 * - req.user contains workspaceId + memberId (WorkspaceMember id)
 *
 * If your auth shape differs, adjust the @CurrentMember decorator below.
 */

// -------------------------
// Minimal "CurrentMember" decorator
// Replace this with your existing one if you already have it.
// -------------------------
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type CurrentMemberCtx = {
  workspaceId: string;
  memberId: string;
};

export const CurrentMember = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentMemberCtx => {
    const req = ctx.switchToHttp().getRequest<any>();
    // Expecting something like req.user = { workspaceId, memberId, userId, ... }
    return {
      workspaceId: req.user.workspaceId,
      memberId: req.user.memberId,
    };
  },
);

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * GET /notifications?take=20&cursor=...&onlyUnread=true
   */
  @Get()
  async list(
    @CurrentMember() me: CurrentMemberCtx,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
    @Query('onlyUnread') onlyUnread?: string,
  ) {
    return this.notifications.list({
      workspaceId: me.workspaceId,
      memberId: me.memberId,
      take: take ? Number(take) : undefined,
      cursor: cursor ?? undefined,
      onlyUnread: onlyUnread === 'true',
    });
  }

  /**
   * GET /notifications/unread-count
   */
  @Get('unread-count')
  async unreadCount(@CurrentMember() me: CurrentMemberCtx) {
    return this.notifications.unreadCount({
      workspaceId: me.workspaceId,
      memberId: me.memberId,
    });
  }

  /**
   * POST /notifications/mark-read
   * body: { ids: string[] }
   */
  @Post('mark-read')
  async markRead(
    @CurrentMember() me: CurrentMemberCtx,
    @Body() body: { ids: string[] },
  ) {
    return this.notifications.markRead({
      workspaceId: me.workspaceId,
      memberId: me.memberId,
      notificationIds: Array.isArray(body?.ids) ? body.ids : [],
    });
  }

  /**
   * POST /notifications/mark-all-read
   */
  @Post('mark-all-read')
  async markAllRead(@CurrentMember() me: CurrentMemberCtx) {
    return this.notifications.markAllRead({
      workspaceId: me.workspaceId,
      memberId: me.memberId,
    });
  }
}

