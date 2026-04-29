import { EncryptionService } from '@/common/utility/encryption.service';
import { DomainEventsService } from '@/events/domain-events.service';
import { ThreadNode } from '@/post/interfaces/post.interface';
import { PrismaService } from '@/prisma/prisma.service';
import { SocialFactory } from '@/social/social.factory';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

@Processor('publishing-queue')
export class PublishPostProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishPostProcessor.name);
  constructor(
    private prisma: PrismaService,
    private socialFactory: SocialFactory,
    private encryptionService: EncryptionService,
    private events: DomainEventsService,
  ) {
    super();
  }

  async process(job: Job<{ postId: string }>) {
    const { postId } = job.data;

    // Load once for routing
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        media: { include: { mediaFile: true }, orderBy: { order: 'asc' } },
        destinations: {
          include: { profile: { include: { connection: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!post) return;

    if (post.status !== 'SCHEDULED') {
      this.logger.warn(
        `Job ${job.id} aborted: Post ${postId} is in status ${post.status}.`,
      );
      return;
    }

    // ============================================================
    // 👇 NEW: ATOMIC LOCK — claim the post for publishing
    // ============================================================
    const claimed = await this.prisma.post.updateMany({
      where: {
        id: postId,
        status: 'SCHEDULED', // only transition from SCHEDULED
      },
      data: { status: 'PUBLISHING' },
    });

    if (claimed.count === 0) {
      // Another worker got it, or status changed (user edited, canceled, etc.)
      this.logger.warn(`Post ${postId} could not be claimed for publishing`);
      return;
    }

    // ============================================================
    // 👇 NEW: MEDIA READINESS CHECK
    // Defer or fail based on attached media status.
    // ============================================================
    const mediaCheck = await this.checkMediaReadiness(post, job);
    if (mediaCheck.action === 'defer') {
      await this.prisma.post.updateMany({
        where: { id: postId, status: 'PUBLISHING' },
        data: { status: 'SCHEDULED' },
      });
      this.logger.log(
        `Post ${postId} deferred: ${mediaCheck.pendingCount} media file(s) still uploading. Retry #${job.attemptsMade + 1}`,
      );
      throw new Error('MEDIA_NOT_READY'); // BullMQ will retry with backoff
    }
    if (mediaCheck.action === 'fail') {
      this.logger.error(
        `Post ${postId} failed permanently: ${mediaCheck.reason}`,
      );
      await this.markPostAsFailed(postId, mediaCheck.reason);
      return; // Don't throw — don't retry, just end.
    }

    // Publish per destination (isolated execution)
    // This avoids needing a replyId map.
    for (const dest of post.destinations) {
      try {
        await this.publishOneDestination(post, dest);
      } catch (e: any) {
        this.logger.error(
          `Publish failed for dest=${dest.id} platform=${dest.profile.platform}: ${e?.message ?? e}`,
          e?.stack,
        );
        // continue to other destinations
      }
    }

    // Recompute post status from destination statuses
    await this.recomputeMasterPostStatus(postId);
  }

  // ===========================================================================
  // Destination router
  // ===========================================================================
  private async publishOneDestination(post: any, dest: any) {
    const platform = dest.profile.platform;

    // Skip already successful
    if (dest.status === 'SUCCESS') return;

    // Atomic claim to avoid double publish
    const claimed = await this.prisma.postDestination.updateMany({
      where: {
        id: dest.id,
        status: { in: ['SCHEDULED', 'FAILED'] },
      },
      data: { status: 'PUBLISHING', errorMessage: null },
    });

    if (claimed.count === 0) return; // someone else / already publishing

    try {
      switch (platform) {
        case 'TWITTER':
          await this.publishTwitterThreadForOneDestination(post, dest);
          break;

        case 'LINKEDIN':
          await this.publishLinkedIn(post, dest);
          break;

        case 'FACEBOOK':
          await this.publishFacebook(post, dest);
          break;

        case 'INSTAGRAM':
          await this.publishInstagram(post, dest);
          break;
        case 'TIKTOK':
          await this.publishTikTok(post, dest);
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      const textPreview =
        (dest.contentOverride || post.content || 'Media post')
          .replace(/\n/g, ' ')
          .substring(0, 60) + '...';

      // TikTok publishes asynchronously — the success/failure event is emitted
      // from the tiktok-publish-status webhook handler once TikTok confirms.
      if (platform !== 'TIKTOK') {
        this.events.emit('publishing.post.published', {
          workspaceId: post.workspaceId,
          postId: post.id,
          postDestinationId: dest.id,
          platform: platform,
          profileName: dest.profile.name,
          snippet: textPreview,
        });
      }
    } catch (e: any) {
      await this.prisma.postDestination.update({
        where: { id: dest.id },
        data: { status: 'FAILED', errorMessage: e?.message ?? 'Unknown error' },
      });
      // 3. EXTRACT RICH DATA
      const textPreview =
        (dest.contentOverride || post.content || 'Media post')
          .replace(/\n/g, ' ')
          .substring(0, 60) + '...';

      this.events.emit('publishing.post.failed', {
        workspaceId: post.workspaceId,
        postId: post.id,
        postDestinationId: dest.id,
        platform: platform,
        profileName: dest.profile.name,
        snippet: textPreview,
        reason: e?.message ?? 'Unknown error',
      });
      throw e;
    }
  }

  // ===========================================================================
  // TWITTER: publish Tweet1 + replies from dest.metadata.thread
  // (isolated execution per destination)
  // ===========================================================================
  private async publishTwitterThreadForOneDestination(post: any, dest: any) {
    const provider = this.socialFactory.getProvider('TWITTER');
    const creds = await this.resolveTwitterCreds(dest);

    const tweet1Text = (dest.contentOverride || post.content || '').trim();
    if (!tweet1Text) throw new Error('Tweet 1 content is empty.');

    // Root media comes from master post media
    const rootMedia = post.media.map((m: any) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
    }));

    // 1) Tweet 1
    const first = await provider.publish(creds as any, tweet1Text, rootMedia, {
      pageId: dest.profile.platformId,
      replyToPostId: undefined,
      postType: post.contentType,
    });

    if (!first?.platformPostId) {
      throw new Error('Twitter returned empty platformPostId for Tweet 1.');
    }

    // Persist Tweet 1 result early (good for retries/observability)
    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        platformPostId: first.platformPostId,
        publishedAt: new Date(),
        platformUrl: first.url,
      },
    });

    let lastId = first.platformPostId;

    // 2) Replies
    const meta = (dest.metadata ?? {}) as any;
    const thread: ThreadNode[] = Array.isArray(meta.thread) ? meta.thread : [];

    for (const node of thread) {
      // Optional targeting per node
      if (
        Array.isArray(node.targetProfileIds) &&
        node.targetProfileIds.length > 0 &&
        !node.targetProfileIds.includes(dest.socialProfileId)
      ) {
        continue;
      }

      const text = (node.content ?? '').trim();
      if (!text) continue;

      const replyMedia = await this.resolveMediaPayload(node.mediaIds ?? []);

      const res = await provider.publish(creds as any, text, replyMedia, {
        pageId: dest.profile.platformId,
        replyToPostId: lastId,
        postType: 'THREAD',
      });

      if (!res?.platformPostId) {
        throw new Error(
          'Twitter returned empty platformPostId for a reply tweet.',
        );
      }

      lastId = res.platformPostId;
    }

    // Mark destination success
    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'SUCCESS',
        errorMessage: null,
        // platformPostId already set to Tweet1 id
      },
    });
  }

  // ===========================================================================
  // Other platforms (stubs: adapt to your providers)
  // ===========================================================================
  private async publishLinkedIn(post: any, dest: any) {
    const provider = this.socialFactory.getProvider('LINKEDIN');
    const creds = await this.resolveOAuth2Creds(dest);

    const text = (dest.contentOverride || post.content || '').trim();

    const mediaPayload = post.media.map((m: any) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
    }));

    const res = await provider.publish(creds as any, text, mediaPayload, {
      pageId: dest.profile.platformId,
      postType: post.contentType,
    });

    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'SUCCESS',
        platformPostId: res?.platformPostId ?? dest.platformPostId ?? null,
        publishedAt: new Date(),
        errorMessage: null,
        platformUrl: res?.url,
      },
    });
  }

  private async publishFacebook(post: any, dest: any) {
    const provider = this.socialFactory.getProvider('FACEBOOK');
    const creds = await this.resolveOAuth2Creds(dest);

    const text = (dest.contentOverride || post.content || '').trim();

    const mediaPayload = post.media.map((m: any) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
    }));

    const res = await provider.publish(creds as any, text, mediaPayload, {
      pageId: dest.profile.platformId,
      postType: post.contentType,
    });

    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'SUCCESS',
        platformPostId: res?.platformPostId ?? dest.platformPostId ?? null,
        publishedAt: new Date(),
        errorMessage: null,
        platformUrl: res?.url,
      },
    });
  }

  private async publishInstagram(post: any, dest: any) {
    const provider = this.socialFactory.getProvider('INSTAGRAM');
    const creds = await this.resolveOAuth2Creds(dest);

    const text = (dest.contentOverride || post.content || '').trim();

    const mediaPayload = post.media.map((m: any) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
    }));

    const res = await provider.publish(creds as any, text, mediaPayload, {
      pageId: dest.profile.platformId,
      postType: post.contentType,
    });

    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        status: 'SUCCESS',
        platformPostId: res?.platformPostId ?? dest.platformPostId ?? null,
        publishedAt: new Date(),
        errorMessage: null,
        platformUrl: res?.url,
      },
    });
  }

  private async publishTikTok(post: any, dest: any) {
    const provider = this.socialFactory.getProvider('TIKTOK');
    const creds = await this.resolveOAuth2Creds(dest);

    const text = (dest.contentOverride || post.content || '').trim();

    // TikTok strictly requires the size of the file for its chunked uploads!
    const mediaPayload = post.media.map((m: any) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
      sizeBytes: Number(m.mediaFile.size), // 👈 Convert Prisma BigInt to Number
    }));

    const res = await provider.publish(creds as any, text, mediaPayload, {
      pageId: dest.profile.platformId,
      postType: post.contentType,
    });

    // TikTok publishes are asynchronous: provider.publish() returns a publish_id
    // acknowledging the upload. The real success/failure arrives later via the
    // tiktok-publish-status webhook, which flips the row to SUCCESS or FAILED.
    // Leave the row in PUBLISHING and store the publish_id so the webhook can
    // find this destination.
    await this.prisma.postDestination.update({
      where: { id: dest.id },
      data: {
        platformPostId: res?.platformPostId ?? dest.platformPostId ?? null,
        errorMessage: null,
      },
    });
  }

  // ===========================================================================
  // Credentials + media helpers
  // ===========================================================================
  private async resolveTwitterCreds(dest: any) {
    // Your model: twitter uses OAuth1:
    // accessToken on profile or connection; token secret in connection.refreshToken
    const encryptedAccessToken =
      dest.profile.accessToken ?? dest.profile.connection.accessToken;
    const rawAccessToken = encryptedAccessToken
      ? await this.encryptionService.decrypt(encryptedAccessToken)
      : undefined;

    const encryptedSecret = dest.profile.connection.refreshToken;
    const rawAccessSecret = encryptedSecret
      ? await this.encryptionService.decrypt(encryptedSecret)
      : undefined;

    if (!rawAccessToken || !rawAccessSecret) {
      throw new Error('Missing Twitter OAuth1 credentials (token/secret).');
    }

    return { accessToken: rawAccessToken, accessSecret: rawAccessSecret };
  }

  private async resolveOAuth2Creds(dest: any) {
    // Generic OAuth2 (LinkedIn/FB/IG typically):
    const encrypted =
      dest.profile.accessToken ?? dest.profile.connection.accessToken;
    const raw = encrypted
      ? await this.encryptionService.decrypt(encrypted)
      : undefined;
    if (!raw) throw new Error('Missing OAuth2 access token.');
    return { accessToken: raw };
  }

  private async resolveMediaPayload(mediaIds: string[]) {
    if (!mediaIds.length) return [];

    const files = await this.prisma.mediaFile.findMany({
      where: { id: { in: mediaIds } },
      select: { url: true, mimeType: true },
    });

    return files.map((f) => ({ url: f.url, mimeType: f.mimeType }));
  }

  // ===========================================================================
  // Master post status recompute
  // ===========================================================================
  // inside PublishPostProcessor

  private async recomputeMasterPostStatus(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, workspaceId: true, status: true },
    });
    if (!post) return;

    const counts = await this.prisma.postDestination.groupBy({
      by: ['status'],
      where: { postId },
      _count: { status: true },
    });

    const map = new Map(counts.map((c) => [c.status, c._count.status]));
    const success = map.get('SUCCESS') ?? 0;
    const failed = map.get('FAILED') ?? 0;
    const scheduled = map.get('SCHEDULED') ?? 0;
    const publishing = map.get('PUBLISHING') ?? 0;

    const remaining = scheduled + publishing;

    let nextStatus: 'PUBLISHING' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' =
      'PUBLISHING';

    if (remaining === 0) {
      if (success > 0 && failed === 0) nextStatus = 'PUBLISHED';
      else if (success > 0 && failed > 0) nextStatus = 'PARTIAL';
      else nextStatus = 'FAILED';
    }

    if (remaining > 0) {
      // Destinations still in flight — another retry may finalize them.
      // Don't mark FAILED yet — that would overwrite the PUBLISHING state
      // and confuse subsequent retries.
      this.logger.warn(
        `Post ${postId} has ${remaining} destinations still active (${scheduled} scheduled, ${publishing} publishing). Deferring final status.`,
      );
      return; // 👈 Don't update master status yet
    }

    // Only update+emit on actual change
    if (post.status !== nextStatus) {
      await this.prisma.post.update({
        where: { id: postId },
        data: {
          status: nextStatus,
          ...(nextStatus === 'PUBLISHED' || nextStatus === 'PARTIAL'
            ? { publishedAt: new Date() }
            : {}),
        },
      });
    }
  }

  /**
   * Checks whether all attached media is ready to publish.
   * Returns an action: 'proceed', 'defer', or 'fail'.
   */
  private async checkMediaReadiness(
    post: any,
    job: Job,
  ): Promise<
    | { action: 'proceed' }
    | { action: 'defer'; pendingCount: number }
    | { action: 'fail'; reason: string }
  > {
    // Post has no media → nothing to check
    if (!post.media?.length) {
      return { action: 'proceed' };
    }

    const failed = post.media.filter(
      (m: any) => m.mediaFile.status === 'FAILED',
    );
    const pending = post.media.filter(
      (m: any) => m.mediaFile.status === 'PENDING_UPLOAD',
    );

    // Any failed media → post can never publish, stop retrying
    if (failed.length > 0) {
      const failedIds = failed.map((m: any) => m.mediaFile.id).join(', ');
      return {
        action: 'fail',
        reason: `Media upload failed: ${failedIds}`,
      };
    }

    // All ready → go
    if (pending.length === 0) {
      return { action: 'proceed' };
    }

    // Some still uploading → defer with a cap
    const MAX_DEFER_ATTEMPTS = 10; // 20 × 30s = 10 min max wait
    if (job.attemptsMade >= MAX_DEFER_ATTEMPTS) {
      return {
        action: 'fail',
        reason: `Media upload timed out after ${MAX_DEFER_ATTEMPTS} retries`,
      };
    }

    return { action: 'defer', pendingCount: pending.length };
  }

  /**
   * Marks the post as FAILED and writes the reason.
   * Called when media is in an unrecoverable state.
   */
  private async markPostAsFailed(postId: string, reason: string) {
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'FAILED',
        errorMessage: reason,
      },
    });
  }
}
