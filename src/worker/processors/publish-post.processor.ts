import { EncryptionService } from '@/common/utility/encryption.service';
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

        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (e: any) {
      await this.prisma.postDestination.update({
        where: { id: dest.id },
        data: { status: 'FAILED', errorMessage: e?.message ?? 'Unknown error' },
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
        !node.targetProfileIds.includes(dest.profileId)
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
        throw new Error('Twitter returned empty platformPostId for a reply tweet.');
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
    const encrypted = dest.profile.accessToken ?? dest.profile.connection.accessToken;
    const raw = encrypted ? await this.encryptionService.decrypt(encrypted) : undefined;
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
  private async recomputeMasterPostStatus(postId: string) {
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

    let status: 'PUBLISHING' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' = 'PUBLISHING';

    if (remaining === 0) {
      if (success > 0 && failed === 0) status = 'PUBLISHED';
      else if (success > 0 && failed > 0) status = 'PARTIAL';
      else status = 'FAILED';
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { status },
    });
  }

}

