import { PrismaService } from '@/prisma/prisma.service';
import { MessageDirection } from '@generated/enums';
import { Injectable } from '@nestjs/common';


export type NormalizedInboundMessage = {
  workspaceId: string;
  socialProfileId: string;

  conversationExternalId: string; // thread id on platform
  contact: {
    platform: string; // Platform enum value as string
    externalId: string;
    username: string;
    avatarUrl?: string | null;
  };

  message: {
    externalId: string; // provider msg id (idempotency key)
    content: string;
    direction: 'INBOUND' | 'OUTBOUND'; // usually inbound
    senderName?: string | null;
    providerTimestamp?: Date | null;
    attachments?: Array<{
      type: string;
      url: string;
      mimeType?: string | null;
      fileSizeBytes?: number | null;
      thumbnailUrl?: string | null;
      meta?: any;
    }>;
  };

  // optional conversation UI metadata
  snippet?: string | null;
  occurredAt?: Date | null;
};

@Injectable()
export class InboxIngestService {
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
          conversationId_externalId: {
            conversationId: conversation.id,
            externalId: evt.message.externalId,
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
          externalId: evt.message.externalId,
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
}
