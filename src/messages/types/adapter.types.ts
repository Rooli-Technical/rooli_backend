import { Platform } from '@generated/enums';

export type NormalizedPlatform =
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'X'
  | 'TWITTER'
  | 'LINKEDIN'
  | 'WHATSAPP'
  | 'EMAIL';

export type NormalizedConversationType =
  | 'DIRECT_MESSAGE'
  | 'POST_COMMENT'
  | 'MENTION';

export type NormalizedMessageDirection = 'INBOUND' | 'OUTBOUND';

export type NormalizedAttachmentType =
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'STICKER'
  | 'UNKNOWN';

export type NormalizedAttachment = {
  type: NormalizedAttachmentType;
  url: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  thumbnailUrl?: string | null;
  meta?: any;
};

export type NormalizedContact = {
  platform: NormalizedPlatform;
  externalId: string; // provider user id (PSID/IGSID/X user id)
  username: string;
  avatarUrl?: string | null;
};

export type NormalizedMessage = {
  externalId: string; // provider message id (Meta mid, X dm_event id, tweet id, comment id)
  content: string;
  direction: NormalizedMessageDirection;
  senderName?: string | null;
  providerTimestamp?: Date | null;
  attachments?: NormalizedAttachment[];
  meta?: any;
};

export type NormalizedInboundMessage = {
  // Prefer to set these in adapter if you can.
  // If not set, worker resolves them from meta.ownerExternalId -> SocialProfile.
  workspaceId?: string;
  socialProfileId?: string;

  // platform + type
  platform: NormalizedPlatform;
  type: NormalizedConversationType;

  // provider thread id (conversation id / dm thread id / comment thread key)
  conversationExternalId: string;

  // the other person
  contact: NormalizedContact;

  // the message
  message: NormalizedMessage;

  // helpful UI metadata
  snippet?: string | null;
  occurredAt?: Date | null;

  // MUST include an "ownerExternalId" when worker needs to map to SocialProfile
  // Examples:
  // - Meta: pageId or igBusinessAccountId (whatever your SocialProfile.externalAccountId stores)
  // - X: the connected account user id
  meta?: {
    ownerExternalId?: string; // required if workspaceId/socialProfileId not present
    rawEventType?: string;
    [k: string]: any;
  };

  // for debugging (don’t store to DB from adapter; worker may choose to log)
  raw?: any;

  accessToken?: string;
};

export interface InboundCommentPayload {
  workspaceId: string;
  socialProfileId: string;
  platform: Platform;
  externalPostId: string;
  externalCommentId: string;
  externalParentId?: string | null; // If it's a reply to another comment
  senderExternalId: string;
  senderAvatarUrl?: string | null;
  senderName: string;
  content: string;
  timestamp: Date;
}
