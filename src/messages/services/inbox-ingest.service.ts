import { PrismaService } from '@/prisma/prisma.service';
import { MessageDirection } from '@generated/enums';
import { Injectable, Logger } from '@nestjs/common';
import { InboundCommentPayload, NormalizedInboundMessage } from '../types/adapter.types';


@Injectable()
export class InboxIngestService {
  private readonly logger = new Logger(InboxIngestService.name);
  
  constructor(private readonly prisma: PrismaService) {}

  async ingestInboundMessage(evt: NormalizedInboundMessage) {
    const occurredAt = evt.occurredAt ?? evt.message.providerTimestamp ?? new Date();
    const snippet = (evt.snippet ?? evt.message.content ?? '').slice(0, 140);

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
          username: evt.contact.username,
          avatarUrl: evt.contact.avatarUrl ?? undefined,
        },
        create: {
          workspaceId: evt.workspaceId,
          platform: evt.contact.platform as any,
          externalId: evt.contact.externalId,
          username: evt.contact.username,
          avatarUrl: evt.contact.avatarUrl ?? null,
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

      return { conversation, message, contact };
    });
  }

async ingestInboundComment(payload: InboundCommentPayload) {
  try {
    // 1. Find the Post via PostDestination (where the external ID actually lives)
    const destination = await this.prisma.postDestination.findFirst({
      where: {
        platformPostId: payload.externalPostId,
        profile: { platform: payload.platform } 
      },
      select: { id: true, postId: true }
    });

    if (!destination) {
      this.logger.warn(`Received comment for unknown post ID: ${payload.externalPostId}. Skipping.`);
      return null; 
    }

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
      },
    });

    return { comment };
  } catch (error: any) {
    this.logger.error(`Failed to ingest comment: ${error.message}`);
    throw error;
  }
}
}
