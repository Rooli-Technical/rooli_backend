import { Injectable } from '@nestjs/common';
import { SocialAdapter } from '../interfaces/social-adapter.interface';
import {
  NormalizedPlatform,
  NormalizedAttachment,
  NormalizedInboundMessage,
} from '../types/adapter.types';

/**
 * Expects job payloads shaped like:
 * - meta-inbound-message: { entryId, messaging, rawEntry }
 * - meta-inbound-comment: { entryId, change, rawEntry }
 *
 * Your controller should enqueue ONE messaging event per job (not the whole entry.messaging array).
 */
@Injectable()
export class MetaAdapter implements SocialAdapter {
  readonly platform: NormalizedPlatform = 'INSTAGRAM'; // We will detect per-event; default is fine.

  normalizeDirectMessage(input: any): NormalizedInboundMessage | null {
    const messaging = input?.messaging ?? input; // support both shapes
    const rawEntry = input?.rawEntry;

    // Meta messaging event basics
    const senderId: string | undefined = messaging?.sender?.id;
    const recipientId: string | undefined = messaging?.recipient?.id; // this is "page/ig id" in some contexts
    const timestampMs: number | undefined = messaging?.timestamp;

    // Ignore non-message events (delivery, read, optin, postback, etc.) here.
    const msg = messaging?.message;
    if (!msg) return null;

    // Ignore echo messages (messages your page sent)
    // Messenger Platform: message.is_echo indicates an echo
    if (msg?.is_echo) return null;

    // Meta message id
    const mid: string | undefined = msg?.mid;
    if (!mid) return null;

    const text: string = (msg?.text ?? '').toString();

    const attachments: NormalizedAttachment[] =
      this.extractMetaMessageAttachments(msg);

    // Identify "ownerExternalId" used to map to SocialProfile.
    // For many setups, recipient.id is the page/ig user id that received the message.
    // Your SocialProfile.externalAccountId should store whatever you choose (pageId or igId).
    const ownerExternalId = recipientId ?? rawEntry?.id;

    // contact is the sender (the external person)
    const contactExternalId = senderId;
    if (!contactExternalId) return null;

    // Username isn't always present in webhook. Use a fallback; you can enrich later via API.
    const username =
      messaging?.sender?.username ||
      messaging?.sender?.name ||
      `meta_${contactExternalId.slice(0, 8)}`;

    const occurredAt = timestampMs ? new Date(timestampMs) : new Date();

    // Best-effort platform inference:
    // If you support both FB + IG, use something in rawEntry/object, or store it on SocialProfile mapping.
    // Here we mark as INSTAGRAM by default, but preserve raw info in meta for later.
    const platform: NormalizedPlatform =
      inferMetaPlatform(input?.objectType) ?? 'FACEBOOK';

    // Conversation external id:
    // Meta does not always provide a "thread id" in messaging webhook.
    // For inbox MVP, key by (owner account + contact) => stable synthetic thread id.
    // When Meta provides a real thread id in your flow, plug it in here.
    const conversationExternalId = buildSyntheticThreadId(
      ownerExternalId,
      contactExternalId,
      'meta:dm',
    );

    return {
      platform,
      type: 'DIRECT_MESSAGE',
      conversationExternalId,
      contact: {
        platform,
        externalId: contactExternalId,
        username,
        avatarUrl: null,
      },
      message: {
        externalId: mid,
        content: text,
        direction: 'INBOUND',
        senderName: messaging?.sender?.name ?? null,
        providerTimestamp: occurredAt,
        attachments: attachments.length ? attachments : undefined,
        meta: {
          quick_replies: msg?.quick_replies,
        },
      },
      snippet: text?.slice(0, 140) ?? null,
      occurredAt,
      meta: {
        ownerExternalId,
        rawEventType: 'meta.dm',
        // Keep minimal raw hints; don’t dump whole payload unless you truly need it
        recipientId,
        senderId,
      },
      raw: undefined,
    };
  }

  // normalizeComment(input: any): NormalizedInboundMessage | null {
  //   console.log(input)
  //   const change = input?.change ?? input;
  //   const rawEntry = input?.rawEntry;

  //   const field = change?.field;
  //   if (field !== 'feed') return null;

  //   const value = change?.value ?? {};
  //   const verb = value?.verb; // add / edit / remove
  //   if (verb && verb !== 'add' && verb !== 'edited') {
  //     // ignore deletes/removes for now
  //     return null;
  //   }

  //   // Common fields on feed changes:
  //   // - post_id
  //   // - comment_id
  //   // - from / sender_name
  //   // - message (comment text)
  //   const postId: string | undefined = value?.post_id;
  //   const commentId: string | undefined =
  //     value?.comment_id ?? value?.comment_id?.toString();
  //   const fromId: string | undefined = value?.from?.id ?? value?.sender_id; // varies
  //   const fromName: string | undefined =
  //     value?.from?.name ?? value?.sender_name;
  //   const messageText: string = (
  //     value?.message ??
  //     value?.text ??
  //     ''
  //   ).toString();
  //   const createdTime = value?.created_time
  //     ? new Date(Number(value.created_time) * 1000)
  //     : new Date();

  //   const ownerExternalId =
  //     rawEntry?.id ?? value?.page_id ?? value?.instagram_business_account_id;
  //   const platform: NormalizedPlatform = inferMetaPlatform(input?.objectType) ?? 'FACEBOOK';

  //   if (!commentId || !postId || !fromId) {
  //     // Some feed events aren't comment creates. Ignore.
  //     return null;
  //   }

  //   // const conversationExternalId = buildSyntheticThreadId({
  //   //   ownerExternalId: ownerExternalId ?? 'unknown_owner',
  //   //   contactExternalId: fromId,
  //   //   kind: `post:${postId}`,
  //   // });

  //   const conversationExternalId = buildSyntheticThreadId(
  //     ownerExternalId,
  //     fromId,
  //     'meta:comment',
  //   );

  //   return {
  //     platform,
  //     type: 'POST_COMMENT',
  //     conversationExternalId,
  //     contact: {
  //       platform,
  //       externalId: fromId,
  //       username: fromName ?? `meta_${fromId.slice(0, 8)}`,
  //       avatarUrl: value.profile_picture || null,
  //     },
  //     message: {
  //       externalId: commentId,
  //       content: messageText,
  //       direction: 'INBOUND',
  //       senderName: fromName ?? null,
  //       providerTimestamp: createdTime,
  //       attachments: undefined,
  //       meta: {
  //         postId,
  //         commentId,
  //         verb,
  //         item: value?.item,
  //       },
  //     },
  //     snippet: messageText.slice(0, 140),
  //     occurredAt: createdTime,
  //     meta: {
  //       ownerExternalId,
  //       rawEventType: 'meta.comment',
  //       postId,
  //       commentId,
  //     },
  //     raw: undefined,
  //   };
  // }

  normalizeComment(input: any): NormalizedInboundMessage | null {
    const { change, rawEntry, objectType } = input;
    const value = change?.value ?? {};
    const field = change?.field;

    // Reject anything that isn't a feed event or an Instagram comment
    if (field !== 'feed' && field !== 'comments') return null;

    // Best-effort platform inference
    const platform: NormalizedPlatform =
      inferMetaPlatform(objectType) ?? 'FACEBOOK';

    // ==========================================
    // 1. INSTAGRAM COMMENTS
    // ==========================================
    if (platform === 'INSTAGRAM' && field === 'comments') {
      const igMessageText: string = value?.text?.toString() ?? '';
      if (!igMessageText) return null; // Ignore non-text events (likes, etc.)

      const igFromId = value?.from?.id;
      const igFromUsername =
        value?.from?.username ?? `meta_${igFromId?.slice(0, 8)}`;
      const igPostId = value?.media?.id;
      const igCommentId = value?.id;
      const igOwnerExternalId = rawEntry?.id; // The Business Account ID receiving the comment

      if (!igCommentId || !igPostId || !igFromId) return null;

      const conversationExternalId = buildSyntheticThreadId(
        igOwnerExternalId,
        igFromId,
        'meta:comment',
      );

      return {
        platform,
        type: 'POST_COMMENT',
        conversationExternalId,
        contact: {
          platform,
          externalId: igFromId,
          username: igFromUsername,
          avatarUrl: null, // IG webhooks don't send avatar URLs on comments
        },
        message: {
          externalId: igCommentId,
          content: igMessageText,
          direction: 'INBOUND',
          senderName: igFromUsername, // Fallback to username for name
          providerTimestamp: new Date(), // IG webhooks don't send timestamp on comments, fallback to now
          attachments: undefined,
          meta: {
            postId: igPostId,
            commentId: igCommentId,
          },
        },
        snippet: igMessageText.slice(0, 140),
        occurredAt: new Date(),
        meta: {
          ownerExternalId: igOwnerExternalId,
          rawEventType: 'meta.comment',
          postId: igPostId,
          commentId: igCommentId,
        },
        raw: undefined,
      };
    }

    // ==========================================
    // 2. FACEBOOK COMMENTS
    // ==========================================
    if (platform === 'FACEBOOK' && field === 'feed') {
      const verb = value?.verb;
      if (verb && verb !== 'add' && verb !== 'edited') return null;

      const fbPostId = value?.post_id;
      const fbCommentId = value?.comment_id?.toString();
      const fbFromId = value?.from?.id ?? value?.sender_id;
      const fbFromName = value?.from?.name ?? value?.sender_name;
      const fbMessageText: string = (
        value?.message ??
        value?.text ??
        ''
      ).toString();

      const createdTime = value?.created_time
        ? new Date(Number(value.created_time) * 1000)
        : new Date();

      const fbOwnerExternalId = rawEntry?.id ?? value?.page_id;

      if (!fbCommentId || !fbPostId || !fbFromId) return null;

      const conversationExternalId = buildSyntheticThreadId(
        fbOwnerExternalId,
        fbFromId,
        'meta:comment',
      );

      return {
        platform,
        type: 'POST_COMMENT',
        conversationExternalId,
        contact: {
          platform,
          externalId: fbFromId,
          username: fbFromName ?? `meta_${fbFromId.slice(0, 8)}`,
          avatarUrl: value?.profile_picture || null,
        },
        message: {
          externalId: fbCommentId,
          content: fbMessageText,
          direction: 'INBOUND',
          senderName: fbFromName ?? null,
          providerTimestamp: createdTime,
          attachments: undefined,
          meta: {
            postId: fbPostId,
            commentId: fbCommentId,
            verb,
            item: value?.item,
          },
        },
        snippet: fbMessageText.slice(0, 140),
        occurredAt: createdTime,
        meta: {
          ownerExternalId: fbOwnerExternalId,
          rawEventType: 'meta.comment',
          postId: fbPostId,
          commentId: fbCommentId,
        },
        raw: undefined,
      };
    }

    return null;
  }

  private extractMetaMessageAttachments(msg: any): NormalizedAttachment[] {
    const out: NormalizedAttachment[] = [];

    // Messenger-style attachments array
    const atts = msg?.attachments;
    if (Array.isArray(atts)) {
      for (const a of atts) {
        const type = mapMetaAttachmentType(a?.type);
        // payload.url exists sometimes; fallback to payload.attachment_id etc.
        const url =
          a?.payload?.url ??
          a?.payload?.src ??
          a?.payload?.image_url ??
          a?.payload?.video_url;

        if (url) {
          out.push({
            type,
            url: String(url),
            mimeType: null,
            thumbnailUrl: a?.payload?.thumbnail_url ?? null,
            meta: {
              attachment_id: a?.payload?.attachment_id,
            },
          });
        } else {
          // If no url, keep meta only; your media processor might fetch using attachment_id later
          if (a?.payload?.attachment_id) {
            out.push({
              type,
              url: '',
              meta: {
                attachment_id: a.payload.attachment_id,
                missingUrl: true,
              },
            });
          }
        }
      }
    }

    return out.filter((x) => x.url || x.meta?.attachment_id);
  }
}

function mapMetaAttachmentType(t: any) {
  const s = String(t ?? '').toLowerCase();
  if (s === 'image') return 'IMAGE';
  if (s === 'video') return 'VIDEO';
  if (s === 'audio') return 'AUDIO';
  if (s === 'file') return 'DOCUMENT';
  if (s === 'sticker') return 'STICKER';
  return 'UNKNOWN';
}

function inferMetaPlatform(
  objectType: string | undefined,
): NormalizedPlatform | null {
  const s = String(objectType ?? '').toLowerCase();

  // Instagram Graph API webhooks explicitly use "instagram"
  if (s === 'instagram') return 'INSTAGRAM';

  // Facebook Messenger webhooks use "page"
  if (s === 'page') return 'FACEBOOK';

  return null;
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
