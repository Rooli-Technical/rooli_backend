import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { MetaAdapter } from '@/messages/adapters/meta.adapter';
import { TwitterAdapter } from '@/messages/adapters/twitter.adapter';

import { PrismaService } from '@/prisma/prisma.service';
import { InboxIngestService } from '@/messages/services/inbox-ingest.service';
import { InboundCommentPayload, NormalizedInboundMessage } from '@/messages/types/adapter.types';
import { DomainEventsService } from '@/events/domain-events.service';
import { Platform } from '@generated/enums';
import { LinkedInAdapter } from '@/messages/adapters/linkedIn.adapter';



@Injectable()
@Processor('inbox-webhooks', { concurrency: 25 })
export class InboundWebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundWebhooksProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: InboxIngestService,
    private readonly metaAdapter: MetaAdapter,
    private readonly twitterAdapter: TwitterAdapter,
    private readonly linkedInAdapter: LinkedInAdapter,
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

           await this.ingest.ingestInboundMessage(resolved);

          return;
        }

        case 'meta-inbound-comment': {
          const normalized = this.metaAdapter.normalizeComment(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          
          
         // 1. Capture the result WITHOUT destructuring it immediately
          const result = await this.ingest.ingestInboundComment(resolved as unknown as InboundCommentPayload);


          if (!result) {
            this.logger.warn(`Skipped emitting comment event: Master Post not found in DB.`);
            return;
          }


          return;
        }

        case 'twitter-inbound-dm': {
          const normalized = this.twitterAdapter.normalizeDirectMessage(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
           await this.ingest.ingestInboundMessage(resolved);
          return;
        }

        case 'twitter-inbound-mention': {
          const normalized = this.twitterAdapter.normalizeMention(job.data);
          if (!normalized) return;

          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          await this.ingest.ingestInboundMessage(resolved);  
          return;
        }
        case 'linkedin-inbound-comment': {
          // 1. Create a LinkedInAdapter to normalize the wild LinkedIn JSON
          const normalized = this.linkedInAdapter.normalizeComment(job.data.payload);
          if (!normalized) return;

          // 2. Resolve the profile just like you do for Meta/Twitter
          const resolved = await this.resolveWorkspaceAndProfile(normalized);
          
          // 3. Save it to the database
          const result = await this.ingest.ingestInboundComment(resolved as unknown as InboundCommentPayload);

          if (!result) {
            this.logger.warn(`Skipped emitting comment event: Master Post not found in DB.`);
            return;
          }


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

    const platformInput = normalized.contact?.platform || normalized.platform;
  
  // 1. Normalize Enum to Uppercase
  const platform = platformInput?.toUpperCase() as Platform;

    if (normalized.workspaceId && normalized.socialProfileId) return normalized;

    const ownerExternalId = normalized.meta?.ownerExternalId;
    if (!ownerExternalId) {
      throw new Error('Missing normalized.meta.ownerExternalId for socialProfile resolution');
    }

    // Adjust this query to match your SocialProfile schema.
    // You need something like (platform, externalAccountId).
    const profile = await this.prisma.socialProfile.findFirst({
      where: {
        platform,
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
