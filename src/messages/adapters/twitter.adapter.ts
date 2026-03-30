import { Injectable } from '@nestjs/common';
import { SocialAdapter } from '../interfaces/social-adapter.interface';
import {
  NormalizedPlatform,
  NormalizedAttachment,
  NormalizedInboundMessage,
} from '../types/adapter.types';

/**
 * Supports Account Activity API style payloads:
 * - direct_message_events: [{ id, created_timestamp, message_create: { sender_id, target: { recipient_id }, message_data: { text, attachment }}}]
 * - tweet_create_events: [{ id_str, text, user: { id_str, screen_name, name }, created_at, entities... }]
 *
 * The controller we wrote enqueues jobs shaped like:
 * - twitter-inbound-dm: { event, raw }
 * - twitter-inbound-mention: { tweet, raw }
 */
@Injectable()
export class TwitterAdapter implements SocialAdapter {
  readonly platform: NormalizedPlatform = 'X';

  normalizeDirectMessage(input: any): NormalizedInboundMessage | null {
    const ev = input?.event ?? input;
    if (!ev) return null;

    const id: string | undefined = ev?.id;
    const createdTs = ev?.created_timestamp
      ? Number(ev.created_timestamp)
      : undefined;

    const mc = ev?.message_create;
    if (!mc) return null;

    const senderId: string | undefined = mc?.sender_id;
    const recipientId: string | undefined = mc?.target?.recipient_id;

    if (senderId === recipientId) {
      // Twitter sometimes fires an event where sender and recipient are the exact same
      return null;
    }

    // NOTE: To truly drop outbounds, you need to know the Connected Account's ID.
    // Since AAAPI puts the connected account in recipientId during inbound DMs,
    // and in senderId during outbound DMs, you should check your Database profile.
    // But for a quick Adapter-level block (if you only want INBOUND):
    // If the webhook payload doesn't explicitly tell you who the "owner" is,
    // your worker might have to do the final `if (senderId === profile.externalId) drop()`.

    // Ignore echoes if you have your own account id; otherwise let worker decide.
    const text: string = (mc?.message_data?.text ?? '').toString();

    const attachments = this.extractXdmAttachment(mc?.message_data);

    // ownerExternalId should be the CONNECTED account id (your profile).
    // In AAAPI DM events, target.recipient_id is typically the account receiving the message.
    // If you store connected account id as SocialProfile.externalAccountId, this maps cleanly.
    const ownerExternalId = recipientId;

    if (!senderId || !ownerExternalId || !id) return null;

    // Conversation key: X AAAPI doesn't give a conversation id in v1.1 style.
    // Make deterministic: owner + other user.
    const conversationExternalId = buildSyntheticThreadId(
      ownerExternalId,
      senderId,
      'x:dm',
    );

    // Optional: username enrichment: AAAPI payload often includes `users` object with profiles.
    // If controller passed raw payload, try to look it up.
    const raw = input?.raw;
    const senderUser = raw?.users?.[senderId];
    const username =
      senderUser?.screen_name ??
      senderUser?.name ??
      `x_${senderId.slice(0, 8)}`;

    const occurredAt = createdTs ? new Date(createdTs) : new Date();

    return {
      platform: 'X',
      type: 'DIRECT_MESSAGE',
      conversationExternalId,
      contact: {
        platform: 'X',
        externalId: senderId,
        username,
        avatarUrl:
          senderUser?.profile_image_url_https ??
          senderUser?.profile_image_url ??
          null,
      },
      message: {
        externalId: id,
        content: text,
        direction: 'INBOUND',
        senderName: senderUser?.name ?? null,
        providerTimestamp: occurredAt,
        attachments: attachments.length ? attachments : undefined,
        meta: {
          // keep minimal
          quick_reply: mc?.message_data?.quick_reply,
        },
      },
      snippet: text.slice(0, 140),
      occurredAt,
      meta: {
        ownerExternalId,
        rawEventType: 'x.dm',
      },
      raw: undefined,
    };
  }

  normalizeMention(input: any): NormalizedInboundMessage | null {
    const tweet = input?.tweet ?? input;
    if (!tweet) return null;

    const tweetId: string | undefined = tweet?.id_str ?? tweet?.id;
    const text: string = (tweet?.text ?? '').toString();
    const user = tweet?.user;

    // If you only want mentions of connected account, your controller should already filter.
    if (!tweetId || !user?.id_str) return null;

    // Identify ownerExternalId (the connected account that was mentioned).
    // AAAPI payload includes `in_reply_to_user_id_str` or entities.user_mentions
    // But it may mention multiple. Use the first mention as "owner" only if that matches your connected account id.
    // Real implementation: controller should route the mention to the right SocialProfile using webhook configuration.
    const ownerExternalId =
      tweet?.in_reply_to_user_id_str ?? firstMentionedUserId(tweet) ?? null;

    if (!ownerExternalId) return null;

    const occurredAt = tweet?.created_at
      ? new Date(tweet.created_at)
      : new Date();

    // Conversation external id: use a stable thread key (owner + author + tweet root if any)
    const root = tweet?.in_reply_to_status_id_str ?? tweetId;
    const conversationExternalId = `x:mention:${ownerExternalId}:${user.id_str}:${root}`;

    return {
      platform: 'X',
      type: 'MENTION',
      conversationExternalId,
      contact: {
        platform: 'X',
        externalId: user.id_str,
        username:
          user.screen_name ?? user.name ?? `x_${user.id_str.slice(0, 8)}`,
        avatarUrl:
          user.profile_image_url_https ?? user.profile_image_url ?? null,
      },
      message: {
        externalId: tweetId,
        content: text,
        direction: 'INBOUND',
        senderName: user.name ?? null,
        providerTimestamp: occurredAt,
        attachments: extractTweetAttachments(tweet),
        meta: {
          inReplyToStatusId: tweet?.in_reply_to_status_id_str ?? null,
          inReplyToUserId: tweet?.in_reply_to_user_id_str ?? null,
        },
      },
      snippet: text.slice(0, 140),
      occurredAt,
      meta: {
        ownerExternalId,
        rawEventType: 'x.mention',
      },
      raw: undefined,
    };
  }

  private extractXdmAttachment(messageData: any): NormalizedAttachment[] {
    const att = messageData?.attachment;
    if (!att) return [];

    const type = mapXdmAttachmentType(att?.type);
    const media = att?.media;
    // URLs in AAAPI DM payload vary; keep whatever is present.
    const url = media?.media_url_https ?? media?.media_url ?? media?.url ?? '';

    const thumb = media?.media_url_https ?? media?.media_url ?? null;

    const out: NormalizedAttachment = {
      type,
      url: String(url),
      thumbnailUrl: thumb,
      meta: {
        media_id: media?.id_str ?? media?.id,
        type: att?.type,
      },
    };

    return out.url || out.meta?.media_id ? [out] : [];
  }
}
function buildSyntheticThreadId(
  ownerId: string,
  contactId: string,
  prefix: string,
) {
  // Sort the IDs so the thread ID is identical regardless of who sent the message
  const sorted = [ownerId, contactId].sort();
  return `${prefix}:${sorted[0]}:${sorted[1]}`;
}

function mapXdmAttachmentType(t: any) {
  const s = String(t ?? '').toLowerCase();
  if (s.includes('photo') || s.includes('image')) return 'IMAGE';
  if (s.includes('video') || s.includes('animated_gif') || s.includes('gif'))
    return 'VIDEO';
  return 'UNKNOWN';
}

function firstMentionedUserId(tweet: any): string | null {
  const mentions = tweet?.entities?.user_mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  const m = mentions[0];
  return m?.id_str ?? m?.id ?? null;
}

function extractTweetAttachments(
  tweet: any,
): NormalizedAttachment[] | undefined {
  const media = tweet?.extended_entities?.media ?? tweet?.entities?.media;
  if (!Array.isArray(media) || media.length === 0) return undefined;

  const out: NormalizedAttachment[] = [];
  for (const m of media) {
    const type = String(m?.type ?? '').toLowerCase();
    const url = m?.media_url_https ?? m?.media_url ?? m?.url;
    if (!url) continue;

    out.push({
      type:
        type === 'photo'
          ? 'IMAGE'
          : type === 'video' || type === 'animated_gif'
            ? 'VIDEO'
            : 'UNKNOWN',
      url: String(url),
      thumbnailUrl: m?.media_url_https ?? m?.media_url ?? null,
      meta: {
        id: m?.id_str ?? m?.id,
        type: m?.type,
        video_info: m?.video_info ?? null,
      },
    });
  }
  return out.length ? out : undefined;
}
