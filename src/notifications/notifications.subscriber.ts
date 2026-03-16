import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { Prisma } from '@generated/client';
import { NotificationType } from '@generated/enums';

/**
 * NotificationsSubscriber
 * - Listens to DOMAIN EVENTS (not webhooks, not controllers)
 * - Decides WHO should be notified
 * - Creates Notification rows (persistent bell icon)
 *
 * Realtime delivery (Socket.io) is NOT done here.
 * Your NotificationsService already emits `notification.created` after inserting,
 * and your events subscriber/gateway can push that to clients.
 *
 * ---------------------------------------------------------
 * Required domain events (examples):
 *
 * Inbox:
 * - 'inbox.message.created' payload: { workspaceId, conversationId, messageId, direction }
 * - 'inbox.message.status.updated' payload: { workspaceId, conversationId, messageId, deliveryStatus, errorCode?, errorMessage? }
 * - 'inbox.conversation.updated' (not needed for notifications generally)
 *
 * Publishing (YOU should emit these from your publishing worker):
 * - 'publishing.post.published' payload: { workspaceId, postId, platform, scheduledPostId?, actorMemberId? }
 * - 'publishing.post.failed'    payload: { workspaceId, postId, platform, reason?, actorMemberId? }
 * - 'publishing.post.declined'  payload: { workspaceId, postId, platform, reason?, actorMemberId? }
 * ---------------------------------------------------------
 */

@Injectable()
export class NotificationsSubscriber {
  private readonly logger = new Logger(NotificationsSubscriber.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ============================================================================
  // INBOX EVENTS
  // ============================================================================

  /**
   * Notify agents about NEW inbound messages.
   * Rules:
   * - Only notify on INBOUND (not OUTBOUND)
   * - If conversation is assigned -> notify assignee only
   * - Else -> notify all workspace members (or a filtered subset)
   */
  @OnEvent('inbox.message.created')
  async onInboxMessageCreated(evt: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  }) {
    try {
      if (evt.direction !== 'INBOUND') return;

      const convo = await this.prisma.inboxConversation.findFirst({
        where: { id: evt.conversationId, workspaceId: evt.workspaceId },
        select: {
          id: true,
          workspaceId: true,
          assignedMemberId: true,
          socialProfileId: true,
          snippet: true,
          contact: {
            select: { username: true, platform: true, avatarUrl: true },
          },
          socialProfile: {
            select: { name: true, picture: true },
          },
        },
      });
      if (!convo) return;

      // Decide recipients
      const recipientMemberIds = convo.assignedMemberId
        ? [convo.assignedMemberId]
        : await this.listWorkspaceMemberIds(convo.workspaceId);

      if (!recipientMemberIds.length) return;

      const title = `New message`;
      const body = `${convo.contact.username} sent a message on ${String(convo.contact.platform)}`;

      await this.notifications.createMany({
        workspaceId: convo.workspaceId,
        memberIds: recipientMemberIds,
        type: NotificationType.INBOX_NEW_MESSAGE,
        title,
        body,
        link: `/inbox/${convo.id}`,
        data: {
          conversationId: convo.id,
          messageId: evt.messageId,
          platform: convo.contact.platform,
          socialProfileId: convo.socialProfileId,
          socialProfileName: convo.socialProfile?.name,
          senderName: convo.contact.username,
          senderAvatar: convo.contact.avatarUrl,
          snippet: convo.snippet,
        } as Prisma.InputJsonValue,
        // dedupeKey prevents spam if webhook retries cause multiple emits
        // (If you added @@unique([memberId, dedupeKey]) then set skipDuplicates true)
        dedupeKey: `inbox:new_message:${evt.messageId}`,
        skipDuplicates: true,
      });
    } catch (e: any) {
      this.logger.warn(
        `onInboxMessageCreated failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  /**
   * Notify agent if an outbound message fails to send.
   * Rules:
   * - Only notify on FAILED
   * - Notify assignee if exists, else all members (MVP)
   *
   * If you later store authorMemberId on InboxMessage, notify ONLY the author.
   */
  @OnEvent('inbox.message.status.updated')
  async onInboxMessageStatusUpdated(evt: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    deliveryStatus: string; // SENT | FAILED | DELIVERED ...
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    try {
      if (String(evt.deliveryStatus).toUpperCase() !== 'FAILED') return;

      const convo = await this.prisma.inboxConversation.findFirst({
        where: { id: evt.conversationId, workspaceId: evt.workspaceId },
        select: {
          id: true,
          workspaceId: true,
          assignedMemberId: true,
          contact: { select: { username: true, platform: true } },
        },
      });
      if (!convo) return;

      const recipientMemberIds = convo.assignedMemberId
        ? [convo.assignedMemberId]
        : await this.listWorkspaceMemberIds(convo.workspaceId);

      const title = `Message failed to send`;
      const body =
        evt.errorMessage?.slice(0, 200) ??
        `Your outbound message failed on ${String(convo.contact.platform)}`;

      await this.notifications.createMany({
        workspaceId: convo.workspaceId,
        memberIds: recipientMemberIds,
        type: NotificationType.SYSTEM_ALERT,
        title,
        body,
        link: `/inbox/${convo.id}`,
        data: {
          conversationId: convo.id,
          messageId: evt.messageId,
          platform: convo.contact.platform,
          errorCode: evt.errorCode ?? null,
        } as Prisma.InputJsonValue,
        dedupeKey: `inbox:send_failed:${evt.messageId}`,
        skipDuplicates: true,
      });
    } catch (e: any) {
      this.logger.warn(
        `onInboxMessageStatusUpdated failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  /**
   * Notify when a thread is assigned (optional event you can emit from InboxService.updateConversation)
   * Event payload you should emit:
   * - 'inbox.conversation.assigned' { workspaceId, conversationId, assignedMemberId, assignedByMemberId? }
   */
  @OnEvent('inbox.conversation.assigned')
  async onConversationAssigned(evt: {
    workspaceId: string;
    conversationId: string;
    assignedMemberId: string;
    assignedByMemberId?: string;
  }) {
    try {
      const convo = await this.prisma.inboxConversation.findFirst({
        where: { id: evt.conversationId, workspaceId: evt.workspaceId },
        select: {
          id: true,
          workspaceId: true,
          contact: { select: { username: true } },
        },
      });
      if (!convo) return;

      await this.notifications.create({
        workspaceId: convo.workspaceId,
        memberId: evt.assignedMemberId,
        type: NotificationType.INBOX_ASSIGNED,
        title: `Conversation assigned to you`,
        body: `${convo.contact.username} thread was assigned to you`,
        link: `/inbox/${convo.id}`,
        data: { conversationId: convo.id } as Prisma.InputJsonValue,
        dedupeKey: `inbox:assigned:${convo.id}:${evt.assignedMemberId}`,
      });
    } catch (e: any) {
      this.logger.warn(
        `onConversationAssigned failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  // ============================================================================
  // PUBLISHING EVENTS
  // ============================================================================

  /**
   * You must emit these from the publishing worker when the state changes.
   * e.g., after you mark the post as PUBLISHED in Prisma:
   *   domainEvents.emit('publishing.post.published', { workspaceId, postId, platform })
   */
  @OnEvent('publishing.post.published')
  async onPostPublished(evt: {
    workspaceId: string;
    postId: string;
    postDestinationId: string;
    platform: string;
    profileName: string;
    snippet: string;
  }) {
    await this.notifyPostEvent({
      workspaceId: evt.workspaceId,
      postId: evt.postId,
      type: NotificationType.POST_PUBLISHED,
      title: `Published to ${evt.profileName}`,
      body: `Your ${evt.platform} post is live.`,
      dedupeKey: `post:published:${evt.postDestinationId}`,
      meta: {
        platform: evt.platform,
        profileName: evt.profileName,
        snippet: evt.snippet,
      } 
    });
  }

  @OnEvent('publishing.post.failed')
  async onPostFailed(evt: {
    workspaceId: string;
    postId: string;
    postDestinationId: string;
    platform: string;
    profileName: string;
    snippet: string;
    reason: string;
    actorMemberId?: string;
  }) {

    const friendlyErrorMessage = `We encountered an issue while publishing to ${evt.platform}. Please check your account connection and try again.`;

    await this.notifyPostEvent({
      workspaceId: evt.workspaceId,
      postId: evt.postId,
      type: NotificationType.POST_FAILED,
      title: `Failed to publish to ${evt.profileName}`,
      body: friendlyErrorMessage,
      dedupeKey: `post:failed:${evt.postDestinationId}`,
      meta: {
        platform: evt.platform,
        profileName: evt.profileName,
        snippet: evt.snippet,
        reason: evt.reason,
        friendlyErrorMessage,
      },
    });
  }

  // @OnEvent('publishing.post.declined')
  // async onPostDeclined(evt: {
  //   workspaceId: string;
  //   postId: string;
  //   platform?: string;
  //   reason?: string;
  //   actorMemberId?: string;
  // }) {
  //   await this.notifyPostEvent({
  //     workspaceId: evt.workspaceId,
  //     postId: evt.postId,
  //     type: NotificationType.POST_DECLINED,
  //     title: `Post declined`,
  //     body: evt.reason?.slice(0, 240) ?? `The platform declined your post`,
  //     dedupeKey: `post:declined:${evt.postId}`,
  //   });
  // }

  /**
   * Helper for publishing events.
   *
   * IMPORTANT:
   * I’m assuming you have a Post-like table with:
   * - id
   * - workspaceId
   * - createdByMemberId (or memberId)
   *
   * If your field name is different, change it here.
   */
  private async notifyPostEvent(params: {
    workspaceId: string;
    postId: string;
    type: NotificationType;
    title: string;
    body: string;
    dedupeKey: string;
    meta: {
      platform: string;
      profileName: string;
      snippet: string;
      reason?: string;
      friendlyErrorMessage?: string;
    };
  }) {
    try {
      // Adjust this to your real model name/fields.
      // Example possibilities:
      // - scheduledPost
      // - post
      // - socialPost
      const post = await this.prisma.post.findFirst({
        where: { id: params.postId, workspaceId: params.workspaceId },
        select: { id: true, workspaceId: true, authorId: true },
      });

      if (!post) return;

      let recipients: string[] = [];

      if (post.authorId) {
        const member = await this.prisma.workspaceMember.findFirst({
          where: {
            workspaceId: post.workspaceId,
            member: {
              userId: post.authorId,
            },
          },
          select: { id: true },
        });

        if (member) {
          recipients = [member.id];
        }
      }

      // 2. Fallback: If no author member found, notify everyone in the workspace
      if (recipients.length === 0) {
        recipients = await this.listWorkspaceMemberIds(post.workspaceId);
      }

      // 3. Final Guard: Don't call createMany if recipients is empty
      if (recipients.length === 0) return;

      await this.notifications.createMany({
        workspaceId: post.workspaceId,
        memberIds: recipients,
        type: params.type,
        title: params.title,
        body: params.body,
        link: `/publishing/posts/${post.id}`,
        data: {
          postId: post.id,
          platform: params.meta.platform,
          profileName: params.meta.profileName,
          snippet: params.meta.snippet,
          failureReason: params.meta.reason || null,
        } as Prisma.InputJsonValue,
        dedupeKey: params.dedupeKey,
        skipDuplicates: true,
      });
    } catch (e: any) {
      // If your Post model is named differently, you’ll get errors here.
      this.logger.warn(`notifyPostEvent failed: ${e?.message ?? String(e)}`);
    }
  }

  @OnEvent('inbox.comment.created')
  async onInboxCommentCreated(evt: {
    workspaceId: string;
    postDestinationId: string;
    commentId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  }) {
    try {
      if (evt.direction !== 'INBOUND') return;

      // 1. Fetch the comment and post info to make a nice notification text
      const comment = await this.prisma.comment.findUnique({
        where: { id: evt.commentId },
        select: {
          senderName: true,
          platform: true,
          content: true,
          senderAvatarUrl: true,
          profileId: true,
          profile: {
            select: { name: true },
          },
        },
      });
      if (!comment) return;

      // 2. Decide who gets it (For MVP, let's just send to all workspace members)
      const recipientMemberIds = await this.listWorkspaceMemberIds(
        evt.workspaceId,
      );
      if (!recipientMemberIds.length) return;

      const title = `New comment`;
      const safeSnippet = comment.content
        ? comment.content.substring(0, 60) +
          (comment.content.length > 60 ? '...' : '')
        : 'sent an attachment';
      const body = `${comment.senderName}: ${safeSnippet}`;

      // 3. Save to Database!
      await this.notifications.createMany({
        workspaceId: evt.workspaceId,
        memberIds: recipientMemberIds,
        type: NotificationType.INBOX_NEW_MESSAGE, // Or create a NEW_COMMENT type!
        title,
        body,
        link: `/inbox/comments/${evt.postDestinationId}`,
        data: {
          postDestinationId: evt.postDestinationId,
          commentId: evt.commentId,
          platform: comment.platform,
          socialProfileId: comment.profileId,
          socialProfileName: comment.profile?.name,
          senderName: comment.senderName,
          senderAvatar: comment.senderAvatarUrl,
          snippet: safeSnippet,
        } as Prisma.InputJsonValue,
        dedupeKey: `inbox:new_comment:${evt.commentId}`,
        skipDuplicates: true,
      });
    } catch (e: any) {
      this.logger.warn(
        `onInboxCommentCreated failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  // ============================================================================
  // TICKET EVENTS
  // ============================================================================

  @OnEvent('ticket.assigned')
  async onTicketAssigned(evt: {
    workspaceId: string;
    ticketId: string;
    ticketNumber: number;
    assigneeId: string;
    assigneeName: string;
  }) {
    try {
      // Find the user who created the ticket
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: evt.ticketId },
        select: { requesterId: true },
      });
      if (!ticket) return;

      await this.notifications.create({
        workspaceId: evt.workspaceId,
        memberId: ticket.requesterId, // Notify the user who asked for help!
        type: NotificationType.SYSTEM_ALERT, // Or create TICKET_ASSIGNED
        title: `Ticket #${evt.ticketNumber} Assigned`,
        body: `${evt.assigneeName} from Rooli Support is now reviewing your ticket.`,
        link: `/support/tickets/${evt.ticketId}`,
        data: { ticketId: evt.ticketId } as Prisma.InputJsonValue,
        dedupeKey: `ticket:assigned:${evt.ticketId}:${evt.assigneeId}`,
      });
    } catch (e: any) {
      this.logger.warn(`onTicketAssigned failed: ${e?.message ?? String(e)}`);
    }
  }

  @OnEvent('ticket.comment.added')
  async onTicketCommentAdded(evt: {
    workspaceId: string;
    ticketId: string;
    isFromSupport: boolean;
    isInternal: boolean;
  }) {
    try {
      // We only want to notify the user if Rooli Support replied publicly!
      if (!evt.isFromSupport || evt.isInternal) return;

      const ticket = await this.prisma.ticket.findUnique({
        where: { id: evt.ticketId },
        select: { ticketNumber: true, requesterId: true },
      });
      if (!ticket) return;

      await this.notifications.create({
        workspaceId: evt.workspaceId,
        memberId: ticket.requesterId,
        type: NotificationType.SYSTEM_ALERT, // Or create TICKET_REPLY
        title: `Rooli Support Replied`,
        body: `You have a new reply on Ticket #${ticket.ticketNumber}.`,
        link: `/support/tickets/${evt.ticketId}`,
        data: { ticketId: evt.ticketId } as Prisma.InputJsonValue,
        dedupeKey: `ticket:reply:${evt.ticketId}:${Date.now()}`,
      });
    } catch (e: any) {
      this.logger.warn(
        `onTicketCommentAdded failed: ${e?.message ?? String(e)}`,
      );
    }
  }

  // ============================================================================
  // Recipient helpers
  // ============================================================================

  /**
   * MVP recipient rule: everyone in the workspace.
   * Later: filter by notification preferences, role/permissions, team assignment, etc.
   */
  private async listWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
