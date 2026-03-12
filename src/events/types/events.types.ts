import { Platform } from '@generated/enums';

export type DomainEventName =
  | 'inbox.message.created'
  | 'inbox.comment.created'
  | 'inbox.conversation.updated'
  | 'inbox.message.status.updated'
  | 'inbox.conversation.assigned'
  | 'inbox.comment.sent'
  | 'inbox.comment.updated'
  | 'publishing.post.published'
  | 'publishing.post.failed'
  | 'publishing.post.declined'
  | 'ticket.created'
  | 'ticket.comment.added'
  | 'ticket.updated'
  | 'notification.created'
  | 'notification.read'
  | 'notification.read_all'
  | 'system.social_profile.connected'
  ;

export type InboxMessageCreatedEvent = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  direction: 'INBOUND' | 'OUTBOUND';
};

export type InboxCommentReplyEvent = {
  workspaceId: string;
  postDestinationId: string;
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
    postDestinationId: string;
    platform?: string;
  };

  'publishing.post.failed': {
    workspaceId: string;
    postDestinationId: string;
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
    postDestinationId: string;
    commentId: string;
    direction: 'INBOUND' | 'OUTBOUND';
  };

  'inbox.comment.sent': {
    workspaceId: string;
    postDestinationId: string; // Internal Post ID
    externalId: string;
    content: string;
    platform: Platform;
  };

  'inbox.comment.updated': {
    workspaceId: string;
    commentId: string;
    status: string;
    error?: string;
  };

  'ticket.created': {
    workspaceId: string;
    ticketId: string;
    ticketNumber: number;
    title: string;
    priority: string;
    status: string;
    requesterName: string;
    createdAt: Date;
  };

  'ticket.comment.added': {
    workspaceId: string;
    ticketId: string;
    id: string; // comment ID
    content: string;
    isFromSupport: boolean;
    isInternal: boolean;
    createdAt: Date;
    author: { id: string; name: string; };
    mediaFiles: any[];
  };

  'ticket.updated': {
    workspaceId: string;
    ticketId: string;
    status?: string;
    priority?: string;
    assigneeId?: string;
    closedAt?: Date | null;
  };

  'system.social_profile.connected': {
    workspaceId: string;
    profileId: string;
    platform: string;
  };
};
