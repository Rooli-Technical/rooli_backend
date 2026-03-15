import { PrismaService } from '@/prisma/prisma.service';
import { MessageDirection } from '@generated/enums';
import { Injectable, Logger } from '@nestjs/common';
import {
  InboundCommentPayload,
  NormalizedInboundMessage,
} from '../types/adapter.types';
import { DomainEventsService } from '@/events/domain-events.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { MetaClient } from '../integrations/meta.client';

@Injectable()
export class InboxIngestService {
  private readonly logger = new Logger(InboxIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventsService,
    private readonly metaClient: MetaClient,
    private readonly encryptionService: EncryptionService,
  ) {}

  async ingestInboundMessage(evt: NormalizedInboundMessage) {

    const occurredAt =
      evt.occurredAt ?? evt.message.providerTimestamp ?? new Date();
    const snippet = (evt.snippet ?? evt.message.content ?? '').slice(0, 140);

    const { resolvedUsername, resolvedAvatarUrl } =
      await this.findSocialContact(evt);

    return this.prisma.$transaction(async (tx) => {
      // 1) upsert contact (workspace-scoped)
      const contact = await tx.socialContact.upsert({
        where: {
          workspaceId_platform_externalId: {
            workspaceId: evt.workspaceId,
            platform: evt.contact.platform as any,
            externalId: evt.contact.externalId,
          },
        },
        update: {
          username: resolvedUsername ?? undefined,
          avatarUrl: resolvedAvatarUrl ?? undefined,
        },
        create: {
          workspaceId: evt.workspaceId,
          platform: evt.contact.platform as any,
          externalId: evt.contact.externalId,
          username: resolvedUsername || 'Unknown User',
          avatarUrl: resolvedAvatarUrl ?? null,
        },
      });

      // 2) upsert conversation (scoped by socialProfileId + externalId)
      const conversation = await tx.inboxConversation.upsert({
        where: {
          socialProfileId_externalId: {
            socialProfileId: evt.socialProfileId,
            externalId: evt.conversationExternalId,
          },
        },
        update: {
          contactId: contact.id,
          lastMessageAt: occurredAt,
          snippet,
          // also unsnooze on new inbound
          snoozedUntil: null,
          archivedAt: null,
        },
        create: {
          workspaceId: evt.workspaceId,
          socialProfileId: evt.socialProfileId,
          externalId: evt.conversationExternalId,
          contactId: contact.id,
          lastMessageAt: occurredAt,
          snippet,
          // status/priority default handled by prisma schema
        },
      });

      const existingMessage = await tx.inboxMessage.findUnique({
        where: {
          conversationId_providerMessageId: {
            conversationId: conversation.id,
            providerMessageId: evt.message.externalId,
          },
        },
        select: { id: true },
      });
      const isNew = !existingMessage;

      // 3) idempotent message insert (unique [conversationId, externalId])
      // If webhook duplicates, this will throw unique constraint; catch outside or use upsert-like pattern.
      // Prisma doesn't support upsert on compound unique unless it's a named @@unique; yours is.
      const message = await tx.inboxMessage.upsert({
        where: {
          conversationId_providerMessageId: {
            conversationId: conversation.id,
            providerMessageId: evt.message.externalId,
          },
        },
        update: {
          // usually nothing, but could update timestamps/attachments if provider sends later
          content: evt.message.content,
          senderName: evt.message.senderName ?? undefined,
          providerTimestamp: evt.message.providerTimestamp ?? undefined,
        },
        create: {
          conversationId: conversation.id,
          clientMessageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          providerMessageId: evt.message.externalId,
          content: evt.message.content ?? '',
          direction:
            evt.message.direction === 'INBOUND'
              ? MessageDirection.INBOUND
              : MessageDirection.OUTBOUND,
          senderName: evt.message.senderName ?? null,
          providerTimestamp: evt.message.providerTimestamp ?? null,
          attachments: evt.message.attachments?.length
            ? {
                create: evt.message.attachments.map((a) => ({
                  type: a.type as any,
                  url: a.url,
                  mimeType: a.mimeType ?? null,
                  fileSizeBytes: a.fileSizeBytes ?? null,
                  thumbnailUrl: a.thumbnailUrl ?? null,
                  meta: a.meta ?? undefined,
                })),
              }
            : undefined,
        },
      });

      if (isNew) {
        this.events.emit('inbox.message.created', {
          workspaceId: evt.workspaceId,
          conversationId: conversation.id,
          messageId: message.id,
          direction: message.direction,
        });

        this.events.emit('inbox.conversation.updated', {
          workspaceId: evt.workspaceId,
          conversationId: conversation.id,
          lastMessageAt: conversation.lastMessageAt,
          snippet: conversation.snippet,
        });
      }

      return { conversation, message, contact };
    });
  }

  async ingestInboundComment(payload: InboundCommentPayload) {
    try {
      // 1. Find the Post via PostDestination (where the external ID actually lives)
      const destination = await this.prisma.postDestination.findFirst({
        where: {
          platformPostId: payload.externalPostId,
          profile: { platform: payload.platform },
        },
        select: { id: true, postId: true },
      });

      if (!destination) {
        this.logger.warn(
          `Received comment for unknown post ID: ${payload.externalPostId}. Skipping.`,
        );
        return null;
      }

      const existingComment = await this.prisma.comment.findUnique({
        where: {
          platform_externalCommentId: {
            platform: payload.platform,
            externalCommentId: payload.externalCommentId,
          },
        },
        select: { id: true },
      });
      const isNew = !existingComment;

      // 2. Resolve parent comment ID for threaded replies
      let internalParentId = null;
      if (payload.externalParentId) {
        const parentComment = await this.prisma.comment.findUnique({
          where: {
            platform_externalCommentId: {
              platform: payload.platform,
              externalCommentId: payload.externalParentId,
            },
          },
          select: { id: true },
        });
        internalParentId = parentComment?.id;
      }

      // 3. Upsert the Comment linked to the Master Post
      const comment = await this.prisma.comment.upsert({
        where: {
          platform_externalCommentId: {
            platform: payload.platform,
            externalCommentId: payload.externalCommentId,
          },
        },
        update: {
          content: payload.content,
          updatedAt: payload.timestamp,
          senderAvatarUrl: payload.senderAvatarUrl,
        },
        create: {
          workspaceId: payload.workspaceId,
          profileId: payload.socialProfileId,
          postDestinationId: destination.id,
          parentId: internalParentId,
          externalCommentId: payload.externalCommentId,
          platform: payload.platform,
          senderExternalId: payload.senderExternalId,
          senderName: payload.senderName,
          content: payload.content,
          createdAt: payload.timestamp,
          externalPostId: payload.externalPostId,
          senderAvatarUrl: payload.senderAvatarUrl,
        },
      });

      if (isNew) {
        this.events.emit('inbox.comment.created', {
          workspaceId: payload.workspaceId,
          postDestinationId: destination.id,
          commentId: comment.id,
          direction: comment.direction,
        });
      }

      return { comment };
    } catch (error: any) {
      this.logger.error(`Failed to ingest comment: ${error.message}`);
      throw error;
    }
  }

  private async findSocialContact(evt: any) {
    if (evt.accessToken) {
      evt.accessToken = await this.encryptionService.decrypt(evt.accessToken);
    }

    let resolvedUsername = evt.contact.username;
    let resolvedAvatarUrl = evt.contact.avatarUrl;

    // 1. Fetch the existing contact AND their updatedAt timestamp
    const existingContact = await this.prisma.socialContact.findUnique({
      where: {
        workspaceId_platform_externalId: {
          workspaceId: evt.workspaceId,
          platform: evt.contact.platform,
          externalId: evt.contact.externalId,
        },
      },
      select: { username: true, avatarUrl: true, updatedAt: true },
    });

    // 2. Determine if we NEED to hit Meta
    // Fetch if they don't exist OR if their data is older than 24 hours
    const isStale = existingContact
      ? new Date().getTime() - existingContact.updatedAt.getTime() >
        24 * 60 * 60 * 1000 // 24 hours
      : true;

    if (
      isStale &&
      (evt.contact.platform === 'FACEBOOK' ||
        evt.contact.platform === 'INSTAGRAM')
    ) {
      try {
        if (!evt.accessToken) throw new Error('Missing accessToken');

        // Fetch FRESH data from Meta!
        const metaProfile = await this.metaClient.fetchContactProfile({
          senderId: evt.contact.externalId,
          platform: evt.contact.platform,
          accessToken: evt.accessToken,
        });

        resolvedUsername =
          metaProfile.username || metaProfile.name || 'Unknown User';
        resolvedAvatarUrl = metaProfile.avatarUrl;

        this.logger.log(
          `Fetched fresh Meta profile for ${evt.contact.externalId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to fetch fresh Meta profile for ${evt.contact.externalId}`,
          error,
        );

        // If Meta fails, fall back to our existing DB data so we don't break the webhook
        if (existingContact) {
          resolvedUsername = existingContact.username;
          resolvedAvatarUrl = existingContact.avatarUrl;
        } else {
          resolvedUsername = 'Unknown User';
        }
      }
    } else if (existingContact) {
      // If it's NOT stale (e.g., they messaged us an hour ago), just use the DB cache
      resolvedUsername = existingContact.username;
      resolvedAvatarUrl = existingContact.avatarUrl;
    }

    // RETURN the data so ingestInboundMessage can use it
    return { resolvedUsername, resolvedAvatarUrl };
  }
}
