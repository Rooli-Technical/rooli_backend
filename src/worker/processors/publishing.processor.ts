import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { SocialFactory } from '@/social/social.factory';

//This is where the magic happens. It receives the postId, loads the data, and (for now) stubs the API call.
@Processor('publishing-queue')
export class PublishingProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishingProcessor.name);

  constructor(
    private prisma: PrismaService,
    private socialFactory: SocialFactory,
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
    // A. Fetch Data (Deep Include)
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        media: { include: { mediaFile: true }, orderBy: { order: 'asc' } },
        destinations: {
          include: {
            profile: {
              include: { connection: true }, // Needed for Connection Tokens
            },
          },
        },
        // Fetch the NEXT child in the chain
        childPosts: {
          take: 1,
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!post) {
      this.logger.warn(`Post ${postId} not found during chain processing.`);
      return;
    }

    // B. Prepare Common Data
    const mediaPayload = post.media.map((m) => ({
      url: m.mediaFile.url,
      mimeType: m.mediaFile.mimeType,
      height: m.mediaFile.height,
      width: m.mediaFile.width,
    }));

    // C. Publish to All Destinations
    const results = await Promise.allSettled(
      post.destinations.map(async (dest) => {
        const provider = this.socialFactory.getProvider(dest.profile.platform);

        // 1. Credentials
        const credentials = {
          accessToken: dest.profile.accessToken || dest.profile.connection.accessToken,
          accessSecret: dest.profile.connection.refreshToken, // Mapped from DB 'refreshToken'
        };

        // 2. Content
        const content = dest.contentOverride || post.content;

        // 3. Metadata
        const metadata = {
          // WHO is posting?
          pageId: dest.profile.platformId,    // Facebook Page ID
          authorUrn: dest.profile.platformId, // LinkedIn URN
          
          // THREADING:
          // If this function was called recursively, 'parentPlatformId' is the ID of the previous tweet.
          // We pass it here so the provider knows to "Reply" to it.
          replyToPostId: parentPlatformId 
        };

        // 4. API Call
        const result = await provider.publish(
          credentials,
          content,
          mediaPayload,
          metadata
        );

        return {
          destinationId: dest.id,
          status: 'SUCCESS',
          platformPostId: result.platformPostId,
        };
      }),
    );

    // D. Handle Results & Update DB
    let successCount = 0;
    let failCount = 0;
    let nextParentId = parentPlatformId; // Default to current parent if fail, but usually we want the NEW ID

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const data = result.value;
        
        // Update Destination Status
        await this.prisma.postDestination.update({
          where: { id: data.destinationId },
          data: {
            status: 'SUCCESS', // Or 'PUBLISHED' depending on your Enum
            publishedAt: new Date(),
            platformPostId: data.platformPostId,
          },
        });

        // 🔑 CAPTURE THE ID FOR THE NEXT CHILD
        // If we successfully posted to Twitter, we need that ID to reply to it next.
        // (Assuming all destinations are the same platform for a thread, or we pick the first valid one)
        if (data.platformPostId) {
          nextParentId = data.platformPostId;
        }

        successCount++;
      } else {
        this.logger.error(`Destination Failed: ${result.reason}`);
        // Optional: Update destination with error message
        failCount++;
      }
    }

    // E. Update Master Post Status
    const finalStatus = failCount === post.destinations.length ? 'FAILED' : 'PUBLISHED';
    await this.prisma.post.update({
      where: { id: postId },
      data: { status: finalStatus, publishedAt: new Date() },
    });

    // F. 🚀 RECURSION STEP
    // If there is a child post waiting AND we successfully got a parent ID from this post...
    if (post.childPosts.length > 0 && nextParentId && successCount > 0) {
      this.logger.log(`Found child post. Continuing chain to ${post.childPosts[0].id} (ReplyTo: ${nextParentId})`);
      
      // Call THIS function again for the child
      await this.processPostChain(post.childPosts[0].id, nextParentId);
    }
  }
}