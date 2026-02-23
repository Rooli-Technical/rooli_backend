import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { MetaAdapter } from '@/inbox/adapters/meta.adapter';
import { TwitterAdapter } from '@/inbox/adapters/twitter.adapter';

import { PrismaService } from '@/prisma/prisma.service';
import { InboxIngestService } from '@/inbox/services/inbox-ingest.service';
import { NormalizedInboundMessage } from '@/inbox/types/adapter.types';
import { DomainEventsService } from '@/events/domain-events.service';



@Injectable()
@Processor('inbox-webhooks', { concurrency: 25 })
export class InboundWebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundWebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: InboxIngestService,
    private readonly metaAdapter: MetaAdapter,
    private readonly twitterAdapter: TwitterAdapter,
    private readonly events: DomainEventsService,
  ) {
    super();
  }

  async process(job: Job<any>) {
    try {
      switch (job.name) {
        case 'meta-inbound-message': {
          const normalized = this.metaAdapter.normalizeDirectMessage(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          const { conversation, message, contact } = await this.ingest.ingestInboundMessage(resolved);

          // ✅ domain events for UI / notifications / analytics
          this.events.emit('inbox.message.created', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            messageId: message.id,
            direction: message.direction,
          });
          this.events.emit('inbox.conversation.updated', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            lastMessageAt: conversation.lastMessageAt,
          });

          return;
        }

        case 'meta-inbound-comment': {
          const normalized = this.metaAdapter.normalizeComment(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          const { conversation, message } = await this.ingest.ingestInboundMessage(resolved);

          this.events.emit('inbox.message.created', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            messageId: message.id,
            direction: message.direction,
          });
          this.events.emit('inbox.conversation.updated', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            lastMessageAt: conversation.lastMessageAt,
          });

          return;
        }

        case 'twitter-inbound-dm': {
          const normalized = this.twitterAdapter.normalizeDirectMessage(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          const { conversation, message } = await this.ingest.ingestInboundMessage(resolved);

          this.events.emit('inbox.message.created', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            messageId: message.id,
            direction: message.direction,
          });
          this.events.emit('inbox.conversation.updated', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            lastMessageAt: conversation.lastMessageAt,
          });

          return;
        }

        case 'twitter-inbound-mention': {
          const normalized = this.twitterAdapter.normalizeMention(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          const { conversation, message } = await this.ingest.ingestInboundMessage(resolved);

          this.events.emit('inbox.message.created', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            messageId: message.id,
            direction: message.direction,
          });
          this.events.emit('inbox.conversation.updated', {
            workspaceId: resolved.workspaceId,
            conversationId: conversation.id,
            lastMessageAt: conversation.lastMessageAt,
          });

          return;
        }

        default:
          this.logger.warn(`Unknown inbox job: ${job.name} (jobId=${job.id})`);
          return;
      }
    } catch (err: any) {
      this.logger.error(
        `Inbound webhook failed [${job.name}] jobId=${job.id}: ${err?.message ?? String(err)}`,
      );
      throw err;
    }
  }

  /**
   * If adapters already set workspaceId + socialProfileId, this returns unchanged.
   * Otherwise resolves by normalized.meta.ownerExternalId (pageId/igId/xUserId, etc).
   */
  private async resolveWorkspaceAndProfile(
    normalized: NormalizedInboundMessage,
  ): Promise<NormalizedInboundMessage> {
    if (normalized.workspaceId && normalized.socialProfileId) return normalized;

    const ownerExternalId = normalized.meta?.ownerExternalId;
    if (!ownerExternalId) {
      throw new Error('Missing normalized.meta.ownerExternalId for socialProfile resolution');
    }

    // Adjust this query to match your SocialProfile schema.
    // You need something like (platform, externalAccountId).
    const profile = await this.prisma.socialProfile.findFirst({
      where: {
        platform: normalized.contact.platform as any,
        platformId: ownerExternalId,
      },
      select: { id: true, workspaceId: true },
    });

    if (!profile) {
      throw new Error(
        `No SocialProfile for platform=${normalized.contact.platform} externalAccountId=${ownerExternalId}`,
      );
    }

    return { ...normalized, socialProfileId: profile.id, workspaceId: profile.workspaceId };
  }
}
