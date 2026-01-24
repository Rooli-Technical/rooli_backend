import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { SocialFactory } from '@/social/social.factory';
import { EncryptionService } from '@/common/utility/encryption.service';
import { raw } from 'express';

//This is where the magic happens. It receives the postId, loads the data, and (for now) stubs the API call.
@Processor('publishing-queue')
export class PublishingProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishingProcessor.name);

  constructor(
    private prisma: PrismaService,
    private socialFactory: SocialFactory,
    private encryptionService: EncryptionService,
  ) {
    super();
  }

  /**
   * 1. ENTRY POINT
   * This simply kicks off the chain. It does NOT do the publishing itself.
   */
  async process(job: Job<{ postId: string }>) {
    const { postId } = job.data;
    this.logger.log(`Start Processing Chain for Post: ${postId}`);

    // We start the recursive chain with the Head Post.
    // parentPlatformId is undefined because the head has no parent.
    await this.processPostChain(postId);

    this.logger.log(`Finished Chain for Post: ${postId}`);
  }

  /**
   * 2. RECURSIVE LOGIC 🔄
   * Handles publishing current post -> updates DB -> calls itself for the child.
   */
  async processPostChain(postId: string, parentPlatformId?: string) {
    try {
      // 1. Fetch Post
      const post = await this.prisma.post.findUnique({
        where: { id: postId },
        include: {
          media: { include: { mediaFile: true }, orderBy: { order: 'asc' } },
          destinations: {
            include: { profile: { include: { connection: true } } },
          },
          childPosts: { take: 1, orderBy: { createdAt: 'asc' } },
        },
      });

      console.log(post);

      if (!post) return;

      const mediaPayload = post.media.map((m) => ({
        url: m.mediaFile.url,
        mimeType: m.mediaFile.mimeType,
      }));

      // 2. Process Destinations
      const results = await Promise.allSettled(
        post.destinations.map(async (dest) => {
          // 🛑 GUARD: THREAD LOGIC (Safety Net)
          // Even if the Service layer filtered these out, this protects us
          // from accidental DB manual inserts.
          if (post.parentPostId && dest.profile.platform !== 'TWITTER') {
            return {
              destinationId: dest.id,
              status: 'SKIPPED',
              message: 'Threading not supported on this platform',
            };
          }

          // A. Resolve Reply ID (Twitter Only)
          let replyToId: string | undefined;

          // If we are in a recursion (parentPlatformId exists) AND this is Twitter
          if (parentPlatformId && dest.profile.platform === 'TWITTER') {
            replyToId = parentPlatformId;
          }

          // B. Publish
          const provider = this.socialFactory.getProvider(
            dest.profile.platform,
          );

          const platform = dest.profile.platform;

          const encryptedAccessToken =
            dest.profile.accessToken ?? dest.profile.connection.accessToken;

          const rawAccessToken = encryptedAccessToken
            ? await this.encryptionService.decrypt(encryptedAccessToken)
            : undefined;

          let rawAccessSecret: string | undefined;

          if (platform === 'TWITTER') {
            const encryptedSecret = dest.profile.connection.refreshToken;

            rawAccessSecret = encryptedSecret
              ? await this.encryptionService.decrypt(encryptedSecret)
              : undefined;

            if (!rawAccessToken || !rawAccessSecret) {
              throw new Error(
                'Missing Twitter OAuth1 credentials (token/secret)',
              );
            }
          } else {
            if (!rawAccessToken) {
              throw new Error(`Missing ${platform} access token`);
            }
          }

          const credentials =
            platform === 'TWITTER'
              ? { accessToken: rawAccessToken!, accessSecret: rawAccessSecret! }
              : { accessToken: rawAccessToken! };

              console.log('Publishing to', platform, 'with credentials', credentials);
          const result = await provider.publish(
            credentials as any,
            dest.contentOverride || post.content,
            mediaPayload,
            {
              pageId: dest.profile.platformId,
              replyToPostId: replyToId,
              postType: post.contentType,
            },
          );
          console.log('Publishing result:', result);

          return {
            destinationId: dest.id,
            platformPostId: result.platformPostId,
          };
        }),
      );

      // 3. Handle Results
      let successCount = 0;
      let failCount = 0;
      let nextParentId = parentPlatformId; // Default to current, update if we get a new one

      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        // ⚠️ Access destination by index because Promise.allSettled preserves order
        const dest = post.destinations[i];

        if (result.status === 'fulfilled') {
          const val = result.value as any;

          // Handle SKIP logic (Don't count as success or fail, just ignore)
          if (val.status === 'SKIPPED') {
            continue;
          }

          await this.prisma.postDestination.update({
            where: { id: dest.id },
            data: {
              status: 'SUCCESS',
              publishedAt: new Date(),
              platformPostId: val.platformPostId,
              errorMessage: null,
            },
          });

          // 🔑 CAPTURE THE ID FOR THE NEXT CHILD
          // If this was a Twitter post, this is the ID Tweet #2 needs to reply to.
          if (val.platformPostId) {
            // 🛑 FIX: Only capture the ID if this destination is the "Thread-Compatible" one (Twitter)
            // You can check the destination's profile platform
            if (dest.profile.platform === 'TWITTER') {
              nextParentId = val.platformPostId;
            }
          }

          successCount++;
        } else {
          failCount++;
          const error = result.reason;
          const isRateLimit = error.response?.status === 429;

          await this.prisma.postDestination.update({
            where: { id: dest.id },
            data: {
              status: 'FAILED',
              errorMessage: isRateLimit
                ? 'Rate limit hit'
                : error.message || 'Unknown error',
            },
          });
        }
      }

      // 4. Update Master Status
      let finalStatus = 'PUBLISHED';

      // Calculate status based on actual attempts (excluding skipped)
      const attemptCount = post.destinations.length;

      if (attemptCount > 0 && failCount === attemptCount) {
        finalStatus = 'FAILED';
      } else if (failCount > 0) {
        finalStatus = 'FAILED';
      }

      await this.prisma.post.update({
        where: { id: postId },
        data: { status: finalStatus as any },
      });

      // 5. Continue Chain
      // 🛑 CORRECTION 2: Pass the ID we captured ('nextParentId') to the child
      if (post.childPosts.length > 0 && nextParentId) {
        // Recursive Call:
        // "Hey Child Post, here is your Parent's Twitter ID (nextParentId). Reply to it."
        await this.processPostChain(post.childPosts[0].id, nextParentId);
      }
    } catch (error) {
      this.logger.error(`System Error: ${error.message}`, error);
      // Don't rethrow unless you want the job to retry indefinitely
    }
  }
}
