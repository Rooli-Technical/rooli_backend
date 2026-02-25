
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { NotificationListDto } from './dtos/notification-list.dto';
import { ApiBearerAuth } from '@nestjs/swagger';

@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser('workspaceMemberId') memberId: string,
    @CurrentUser('workspaceId') workspaceId: string,
   @Query() query: NotificationListDto,
  ) {
    return this.notifications.list({
      workspaceId,
      memberId,
     ...query,
    });
  }


  @Get('unread-count')
  async unreadCount(@CurrentUser() me) {
    return this.notifications.unreadCount({
      workspaceId: me.workspaceId,
      memberId: me.workspaceMemberId,
    });
  }

  /**
   * POST /notifications/mark-read
   * body: { ids: string[] }
   */
  @Post('mark-read')
  async markRead(
    @CurrentUser() me,
    @Body() body: { ids: string[] },
  ) {
    return this.notifications.markRead({
      workspaceId: me.workspaceId,
      memberId: me.workspaceMemberId,
      notificationIds: Array.isArray(body?.ids) ? body.ids : [],
    });
  }

  @Post('mark-all-read')
  async markAllRead(@CurrentUser() me) {
    return this.notifications.markAllRead({
      workspaceId: me.workspaceId,
      memberId: me.workspaceMemberId,
    });
  }
}

