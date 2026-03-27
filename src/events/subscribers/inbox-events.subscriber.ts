import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventsGateway } from '../events.gateway';
import {
  InboxMessageCreatedEvent,
  InboxConversationUpdatedEvent,
  InboxMessageStatusUpdatedEvent,
  InboxCommentReplyEvent,
} from '../types/events.types';
import { RealtimeEmitterService } from '../realtime-emitter.service';
/**
 * Routes domain events to transports:
 * - WebSockets (Socket.io)
 * - Later: notifications, analytics, email, etc.
 *
 * Keep it thin: translate payload -> emit.
 */
@Injectable()
export class InboxEventsSubscriber {
  constructor(private readonly emitterService: RealtimeEmitterService) {}

  @OnEvent('inbox.message.created', { async: false })
  onMessageCreated(evt: InboxMessageCreatedEvent) {
    // Workspace-wide: update list + badges
    this.emitterService.emitToWorkspace(
      evt.workspaceId,
      'inbox.message.created',
      evt,
    );

    // Conversation-specific: update open thread view
    this.emitterService.emitToConversation(
      evt.workspaceId,
      evt.conversationId,
      'inbox.thread.message',
      evt,
    );
  }

  @OnEvent('inbox.conversation.updated', { async: false })
  onConversationUpdated(evt: InboxConversationUpdatedEvent) {
    this.emitterService.emitToWorkspace(
      evt.workspaceId,
      'inbox.conversation.updated',
      evt,
    );
  }

  @OnEvent('inbox.message.status.updated', { async: false })
  onMessageStatusUpdated(evt: InboxMessageStatusUpdatedEvent) {
    this.emitterService.emitToWorkspace(
      evt.workspaceId,
      'inbox.message.status.updated',
      evt,
    );
    this.emitterService.emitToConversation(
      evt.workspaceId,
      evt.conversationId,
      'inbox.thread.message_status',
      evt,
    );
  }

  @OnEvent('inbox.comment.sent')
  handleInboxCommentSent(evt: InboxCommentReplyEvent) {
    this.emitterService.emitToWorkspace(
      evt.workspaceId,
      'inbox.comment.sent',
      evt,
    );
    this.emitterService.emitToConversation(
      evt.workspaceId,
      evt.postDestinationId,
      'inbox.comment.sent',
      evt,
    );
  }

  @OnEvent('inbox.comment.created')
  handleCommentCreated(payload: {
    workspaceId: string;
    postId: string;
    commentId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  }) {
    this.emitterService.emitToWorkspace(
      payload.workspaceId,
      'inbox.comment.created',
      payload,
    );
  }

  @OnEvent('inbox.comment.updated')
  handleCommentUpdated(payload: {
    workspaceId: string;
    commentId: string;
    status: string;
    error?: string;
  }) {
    this.emitterService.emitToWorkspace(
      payload.workspaceId,
      'inbox.comment.updated',
      payload,
    );
  }
}
