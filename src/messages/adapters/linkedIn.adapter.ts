import { Injectable } from '@nestjs/common';
import {
  NormalizedPlatform,
  NormalizedInboundMessage,
} from '../types/adapter.types';

@Injectable()
export class LinkedInAdapter {
  readonly platform: NormalizedPlatform = 'LINKEDIN';

  /**
   * Normalizes LinkedIn Organization Comments from webhooks.
   * Note: LinkedIn's webhook is called ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS.
   */
  normalizeComment(input: any): NormalizedInboundMessage | null {
    // The payload usually comes nested, depending on how your webhook controller passes it
    const payload = input?.payload ?? input;

    // We only care about COMMENT actions (ignore LIKE, SHARE, etc.)
    const actionType = payload?.actionType;
    if (actionType !== 'COMMENT') {
      return null;
    }

    // Identify the LinkedIn Company Page (The owner)
    // Format: "urn:li:organization:12345"
    const orgUrn: string | undefined = payload?.organizationalEntity;
    if (!orgUrn) return null;

    // Identify the sender (The person/company who commented)
    // Format: "urn:li:person:67890" or "urn:li:organization:12345"
    const actorUrn: string | undefined = payload?.actor;
    if (!actorUrn) return null;

    // Identify the specific comment and the post it belongs to
    const commentUrn: string | undefined = payload?.commentUrn;
    const postUrn: string | undefined = payload?.socialAction; // This is the post URN

    if (!commentUrn || !postUrn) return null;

    // Sometimes LinkedIn webhooks omit the text, requiring a secondary fetch.
    // For MVP, we extract what is there.
    const messageText: string = (payload?.text ?? '').toString();

    // Determine direction
    const isFromUs = actorUrn === orgUrn;
    const direction = isFromUs ? 'OUTBOUND' : 'INBOUND';

    // Build a stable conversation ID for the UI to group comments
    const conversationExternalId = this.buildSyntheticThreadId(
      orgUrn,
      actorUrn,
      `linkedin:comment:${postUrn}`,
    );

    const occurredAt = payload?.createdAt
      ? new Date(payload.createdAt)
      : new Date();

    return {
      platform: this.platform,
      type: 'POST_COMMENT',
      conversationExternalId,
      contact: {
        platform: this.platform,
        externalId: actorUrn,
        // LinkedIn webhooks do NOT include names/avatars for privacy reasons.
        // You must use a generic fallback here. Your IngestService or a background worker
        // will need to call the LinkedIn Profile API later to hydrate this if needed.
        username: isFromUs
          ? 'Us'
          : `LinkedIn Member (${actorUrn.split(':').pop()})`,
        avatarUrl: null,
      },
      message: {
        externalId: commentUrn,
        content: messageText,
        direction,
        senderName: isFromUs ? 'Us' : 'LinkedIn Member',
        providerTimestamp: occurredAt,
        attachments: undefined, // LinkedIn doesn't send media in this webhook
        meta: {
          postId: postUrn,
          commentId: commentUrn,
          externalPostId: postUrn, // Critical for your IngestService to link to PostDestination
        },
      },
      snippet: messageText.slice(0, 140),
      occurredAt,
      meta: {
        ownerExternalId: orgUrn,
        rawEventType: 'linkedin.comment',
        postId: postUrn,
        commentId: commentUrn,
      },
      raw: undefined,
    };
  }

  /**
   * Normalizes LinkedIn DMs (Polled data, since LI has no DM webhooks).
   * Note: The structure here depends entirely on the response from the
   * GET /conversations API endpoint.
   */
  normalizeDirectMessage(input: any): NormalizedInboundMessage | null {
    const message = input?.message ?? input;

    // LinkedIn Conversations API structure:
    const messageId = message?.entityUrn;
    if (!messageId) return null;

    const senderUrn = message?.sender;
    const conversationId = message?.conversationUrn; // LI provides actual thread IDs!
    const text = message?.eventContent?.messageEvent?.customContent?.text || '';

    // You must pass the orgUrn in the input wrapper when you poll
    const ownerExternalId = input?.ownerExternalId;
    if (!ownerExternalId || !senderUrn) return null;

    const isFromUs = senderUrn === ownerExternalId;
    const direction = isFromUs ? 'OUTBOUND' : 'INBOUND';

    const timestampMs = message?.createdAt;
    const occurredAt = timestampMs ? new Date(timestampMs) : new Date();

    return {
      platform: this.platform,
      type: 'DIRECT_MESSAGE',
      conversationExternalId: conversationId, // Use LinkedIn's native conversation ID!
      contact: {
        platform: this.platform,
        externalId: senderUrn,
        username: `LinkedIn Member (${senderUrn.split(':').pop()})`,
        avatarUrl: null,
      },
      message: {
        externalId: messageId,
        content: text,
        direction,
        senderName: null,
        providerTimestamp: occurredAt,
        attachments: undefined, // Add parsing for LI attachments here if needed
        meta: {},
      },
      snippet: text.slice(0, 140),
      occurredAt,
      meta: {
        ownerExternalId,
        rawEventType: 'linkedin.dm',
      },
      raw: undefined,
    };
  }

  private buildSyntheticThreadId(
    ownerId: string,
    contactId: string,
    prefix: string,
  ) {
    const sorted = [ownerId, contactId].sort();
    return `${prefix}:${sorted[0]}:${sorted[1]}`;
  }
}
