import { EncryptionService } from '@/common/utility/encryption.service';
import { LinkedInAdapter } from '@/messages/adapters/linkedIn.adapter';
import { MetaAdapter } from '@/messages/adapters/meta.adapter';
import { InboxIngestService } from '@/messages/services/inbox-ingest.service';
import { InboundCommentPayload } from '@/messages/types/adapter.types';
import { InstagramInboxProvider } from '@/polling/providers/instagram-inbox.provider';
import { LinkedInInboxProvider } from '@/polling/providers/linkedin-inbox.provider';
import { MetaInboxProvider } from '@/polling/providers/meta-inbox.provider';
import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('inbox-sync', { concurrency: 10 }) // Process 10 syncs simultaneously
export class InboxSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(InboxSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly linkedInProvider: LinkedInInboxProvider,
    private readonly metaProvider: MetaInboxProvider,
    private readonly linkedInAdapter: LinkedInAdapter,
    private readonly instagramProvider: InstagramInboxProvider,
    private readonly metaAdapter: MetaAdapter,
    private readonly ingest: InboxIngestService,
  ) {
    super();
  }

  async process(
    job: Job<{ profileId: string; platform: Platform }>,
  ): Promise<void> {
    const { profileId, platform } = job.data;
    this.logger.debug(
      `Starting Inbox Sync for Profile: ${profileId} (${platform})`,
    );

    try {
      // 1. Fetch Profile & Credentials
      const profile = await this.prisma.socialProfile.findUnique({
        where: { id: profileId },
        include: { connection: true },
      });

      if (!profile || !profile.accessToken) {
        throw new Error(`Profile ${profileId} not found or missing token`);
      }

      const accessToken = await this.encryptionService.decrypt(
        profile.accessToken,
      );

      // 2. Route to the correct platform logic
      switch (platform) {
        case Platform.LINKEDIN:
          await this.syncLinkedIn(profile, accessToken);
          break;
        // case Platform.FACEBOOK:
        //   await this.syncMeta(profile, accessToken);
        //   break;
        // case Platform.INSTAGRAM:
        //   await this.syncInstagram(profile, accessToken);
        //   break;
        default:
          this.logger.warn(`Polling not supported for platform: ${platform}`);
      }

      this.logger.debug(`✅ Completed Inbox Sync for Profile: ${profileId}`);
    } catch (error: any) {
      this.logger.error(
        `Inbox Sync failed for profile ${profileId}: ${error.message}`,
      );
      throw error; // Let BullMQ retry
    }
  }

// ==========================================
  // LINKEDIN SYNC LOGIC
  // ==========================================
  private async syncLinkedIn(profile: any, accessToken: string) {
    const lastPolledAt = Date.now() - (7 * 24 * 60 * 60 * 1000);

    let entityUrn = profile.platformId;
    if (!entityUrn.startsWith('urn:li:')) {
      const isNumeric = /^\d+$/.test(entityUrn);
      entityUrn = isNumeric 
        ? `urn:li:organization:${entityUrn}` 
        : `urn:li:person:${entityUrn}`;
    }

    // 🚨 1. Fetch only posts published via YOUR APP from your database!
    // We grab their 10 most recent successful posts.
    const recentAppPosts = await this.prisma.postDestination.findMany({
      where: {
        socialProfileId: profile.id,
        status: 'SUCCESS',
        platformPostId: { not: null },
      },
      orderBy: { publishedAt: 'desc' },
      take: 10,
    });

    if (recentAppPosts.length === 0) {
      this.logger.debug(`No app-published posts found for ${profile.id}. Skipping.`);
      return;
    }

    // Extract just the LinkedIn URNs
    const postUrns = recentAppPosts.map(post => post.platformPostId!);

    this.logger.debug(`Fetching comments for ${postUrns.length} app-published posts...`);

    // 🚨 2. Pass the array of post URNs to your provider
    const rawComments = await this.linkedInProvider.getRecentComments(
      entityUrn,
      postUrns, // Pass the array here!
      accessToken,
      lastPolledAt,
    );

    // 3. Normalize & Save each comment
    for (const raw of rawComments) {
      // 🚨 HYDRATE: Get the name and avatar!
      const profileInfo = await this.linkedInProvider.resolveActorProfile(
        raw.payload.actor, 
        accessToken
      );

      const normalized = this.linkedInAdapter.normalizeComment(raw);
      if (normalized) {
        const payload = this.mapToCommentPayload(
          normalized,
          profile.workspaceId,
          profile.id,
        );

        // 🚨 OVERWRITE with the real names!
        payload.senderName = profileInfo.name;
        payload.senderAvatarUrl = profileInfo.avatar;

        await this.ingest.ingestInboundComment(payload);
      }
    }
  }
  // ==========================================
  // META SYNC LOGIC (Fallback)
  // ==========================================
  private async syncMeta(profile: any, accessToken: string) {
    // 1. Fetch raw API data
    const rawComments = await this.metaProvider.getRecentComments(
      profile.platformId,
      accessToken,
    );

    // 2. Normalize & Save
    for (const raw of rawComments) {
      const normalized = this.metaAdapter.normalizeComment(raw);
      if (normalized) {
        const payload = this.mapToCommentPayload(
          normalized,
          profile.workspaceId,
          profile.id,
        );
        await this.ingest.ingestInboundComment(payload);
      }
    }
  }

  private async syncInstagram(profile: any, accessToken: string) {
    // Comments
    const rawComments = await this.instagramProvider.getRecentComments(
      profile.platformId,
      accessToken,
    );
    for (const raw of rawComments) {
      // We still use the MetaAdapter here because it handles IG perfectly!
      const normalized = this.metaAdapter.normalizeComment(raw);
      if (normalized) {
        const payload = this.mapToCommentPayload(
          normalized,
          profile.workspaceId,
          profile.id,
        );
        await this.ingest.ingestInboundComment(payload);
      }
    }

    // DMs
    const rawDms = await this.instagramProvider.getRecentDMs(
      profile.platformId,
      accessToken,
      profile.facebookPageId,
    );
    for (const dm of rawDms) {
      const normalizedDm = this.metaAdapter.normalizeDirectMessage(dm);
      if (normalizedDm) {
        await this.ingest.ingestInboundMessage({
          ...normalizedDm,
          workspaceId: profile.workspaceId,
          socialProfileId: profile.id,
        });
      }
    }
  }

  private mapToCommentPayload(
    normalized: any,
    workspaceId: string,
    socialProfileId: string,
  ): InboundCommentPayload {
    return {
      workspaceId,
      socialProfileId,
      platform: normalized.platform as Platform,
      externalCommentId: normalized.message.externalId,
      content: normalized.message.content,
      timestamp:
        normalized.message.providerTimestamp ||
        normalized.occurredAt ||
        new Date(),
      externalPostId:
        normalized.message.meta?.postId || normalized.meta?.postId,
      externalParentId: normalized.message.meta?.parentId || null,
      senderExternalId: normalized.contact.externalId,
      senderName: normalized.contact.username || 'Unknown User',
      senderAvatarUrl: normalized.contact.avatarUrl || null,
    };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.log(error);
    this.logger.error(`❌ Inbox Sync Job Failed [${job.id}]: ${error.message}`);
  }
}
