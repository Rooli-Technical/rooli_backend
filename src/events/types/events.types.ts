import { Platform } from '@generated/enums';

export type DomainEventName =
  | 'inbox.message.created'
  | 'inbox.conversation.updated'
  | 'inbox.message.status.updated'
  | 'inbox.conversation.assigned'
  | 'publishing.post.published'
  | 'publishing.post.failed'
  | 'publishing.post.declined'
  | 'notification.created'
  | 'notification.read'
  | 'notification.read_all';

export type InboxMessageCreatedEvent = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  direction: 'INBOUND' | 'OUTBOUND';
};

export type InboxCommentReplyEvent = {
  workspaceId: string;
  postId: string;
  externalId: string;
  content: string;
  platform: Platform;
};

export type InboxConversationUpdatedEvent = {
  workspaceId: string;
  conversationId: string;
  lastMessageAt?: string | Date;
  snippet?: string | null;
};

export type InboxMessageStatusUpdatedEvent = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  deliveryStatus: string; // SENT | DELIVERED | READ | FAILED | ...
  errorCode?: string | null;
  errorMessage?: string | null;
  providerMessageId?: string | null;
};

export type DomainEventPayloadMap = {
  'inbox.message.created': {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  };

  'inbox.conversation.updated': {
    workspaceId: string;
    conversationId: string;
    lastMessageAt?: Date | string;
    snippet?: string | null;
  };

  'inbox.message.status.updated': {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    deliveryStatus: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    providerMessageId?: string | null;
  };

  'inbox.conversation.assigned': {
    workspaceId: string;
    conversationId: string;
    assignedMemberId: string;
    assignedByMemberId?: string;
  };

  'publishing.post.published': {
    workspaceId: string;
    postId: string;
    platform?: string;
  };

  'publishing.post.failed': {
    workspaceId: string;
    postId: string;
    platform?: string;
    reason?: string;
  };

  'publishing.post.declined': {
    workspaceId: string;
    postId: string;
    platform?: string;
    reason?: string;
  };

  'notification.created': {
    workspaceId: string;
    memberId: string;
    notification: any; // you can type this later
  };

  'notification.read': {
    workspaceId: string;
    memberId: string;
    notificationIds: string[];
    readAt: Date;
  };

  'notification.read_all': {
    workspaceId: string;
    memberId: string;
    readAt: Date;
  };

  'inbox.comment.created': {
    workspaceId: string;
    postId: string;
    commentId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  };

  'inbox.comment.sent': {
    workspaceId: string;
    postId: string; // Internal Post ID
    externalId: string;
    content: string;
    platform: Platform;
  };
};
