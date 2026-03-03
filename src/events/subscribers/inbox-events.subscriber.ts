import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventsGateway } from '../events.gateway';
import {
  InboxMessageCreatedEvent,
  InboxConversationUpdatedEvent,
  InboxMessageStatusUpdatedEvent,
  InboxCommentReplyEvent,
} from '../types/events.types';
/**
 * Routes domain events to transports:
 * - WebSockets (Socket.io)
 * - Later: notifications, analytics, email, etc.
 *
 * Keep it thin: translate payload -> emit.
 */
@Injectable()
export class InboxEventsSubscriber {
  constructor(private readonly gateway: EventsGateway) {}

  @OnEvent('inbox.message.created', { async: false })
  onMessageCreated(evt: InboxMessageCreatedEvent) {
    // Workspace-wide: update list + badges
    this.gateway.emitToWorkspace(evt.workspaceId, 'inbox.message.created', evt);

    // Conversation-specific: update open thread view
    this.gateway.emitToConversation(
      evt.workspaceId,
      evt.conversationId,
      'inbox.thread.message',
      evt,
    );
  }

  @OnEvent('inbox.conversation.updated', { async: false })
  onConversationUpdated(evt: InboxConversationUpdatedEvent) {
    this.gateway.emitToWorkspace(
      evt.workspaceId,
      'inbox.conversation.updated',
      evt,
    );
  }

  @OnEvent('inbox.message.status.updated', { async: false })
  onMessageStatusUpdated(evt: InboxMessageStatusUpdatedEvent) {
    this.gateway.emitToWorkspace(
      evt.workspaceId,
      'inbox.message.status.updated',
      evt,
    );
    this.gateway.emitToConversation(
      evt.workspaceId,
      evt.conversationId,
      'inbox.thread.message_status',
      evt,
    );
  }

  @OnEvent('inbox.comment.sent')
  handleInboxCommentSent(evt: InboxCommentReplyEvent) {
    this.gateway.emitToWorkspace(evt.workspaceId, 'inbox.comment.sent', evt);
    this.gateway.emitToConversation(
      evt.workspaceId,
      evt.postId,
      'inbox.comment.sent',
      evt,
    );
  }
}
