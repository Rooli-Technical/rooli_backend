import {
  AuthCredentials,
  PostMetrics,
} from '@/analytics/interfaces/analytics-provider.interface';
import { AnalyticsNormalizerService } from '@/analytics/services/analytics-normalizer.service';
import { AnalyticsRepository } from '@/analytics/services/analytics.repository';
import { AnalyticsService } from '@/analytics/services/analytics.service';
import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('analytics-queue')
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly fetcher: AnalyticsService,
    private readonly normalizer: AnalyticsNormalizerService,
    private readonly repo: AnalyticsRepository,
  ) {
    super();
  }

  async process(job: Job<{ socialProfileId: string }>): Promise<void> {
    // BullMQ uses job.name to distinguish between different task types
    switch (job.name) {
      case 'fetch-stats':
        await this.handleDailyFetch(job);
        break;
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `❌ Analytics Job Failed [Profile: ${job.data.socialProfileId}]: ${error.message}`,
      error.stack,
    );
  }

  //  NEW: Track completed jobs (Optional, good for debugging volume)
  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(
      `✅ Analytics Job Completed [Profile: ${job.data.socialProfileId}]`,
    );
  }

  private async handleDailyFetch(job: Job<{ socialProfileId: string }>) {
    const { socialProfileId } = job.data;
    this.logger.log(`Starting analytics fetch for profile: ${socialProfileId}`);

    try {
      const profile = await this.prisma.socialProfile.findUnique({
        where: { id: socialProfileId },
        include: { connection: true },
      });

      if (!profile || !profile.connection) {
        throw new Error(
          `Profile ${socialProfileId} not found or disconnected.`,
        );
      }

      const credentials = await this.getCredentials(profile);

      // FIX: Ensure method name matches your AnalyticsService (getAccountStats)
      this.logger.debug(`Fetching account stats for ${profile.platform}...`);
      const rawAccount = await this.fetcher.fetchAccountStats(
        profile.platform,
        profile.platformId,
        credentials,
      );
      console.log("raw Acount")
      console.log(rawAccount)

      const accountPayload = await this.normalizer.normalizeAccountStats(
        profile.id,
        rawAccount,
      );
      console.log("account payload")
      console.log(accountPayload)

      await this.repo.saveAccountAnalytics(accountPayload);

      await this.processPosts(
        profile.id,
        profile.platform,
        credentials,
        profile.platformId,
      );

      this.logger.log(`Analytics fetch completed for ${socialProfileId}`);
    } catch (error) {
      console.log(error)
      this.logger.error(`Analytics job failed: ${error.message}`);
      throw error;
    }
  }

  // ==========================================
  // HELPER METHODS
  // ==========================================

  /**
   * Helper to fetch active posts, batch them, and save stats
   */
  private async processPosts(
    profileId: string,
    platform: Platform,
    credentials: AuthCredentials,
    pageId?: string, // Used for LinkedIn Context
  ) {
    // A. Get posts we want to track (e.g., last 30 posts)
    const postsToUpdate = await this.repo.getPostsForUpdate(profileId, 30);

    if (postsToUpdate.length === 0) return;

    // B. Extract External IDs
    const externalIds = postsToUpdate.map((p) => p.platformPostId);

    // C. Fetch from API (The Fetcher handles the Batching internally per provider rules)
    // Pass 'pageId' as context for LinkedIn
    let rawPosts: PostMetrics[] = [];
    try {
      rawPosts = await this.fetcher.fetchPostStats(
        platform,
        externalIds,
        credentials,
        { pageId },
      );
      console.log("raw posts")
      console.log(rawPosts)
    } catch (error) {
      console.log(error)
      this.logger.error(
        `Failed to fetch post stats for profile ${profileId}: ${error.message}`,
        error.stack,
      );
      // Optionally, return early or continue with empty rawPosts for partial success
    }


    const postMap = new Map(postsToUpdate.map((p) => [p.platformPostId, p]));

    // D. Normalize & Save Loop with per-post try-catch
    for (const rawPost of rawPosts) {
      try {
        // Find the matching internal post ID
        const internalPost = postMap.get(rawPost.postId);
        if (internalPost) {
          const snapshot = this.normalizer.normalizePostStats(
            internalPost.id,
            rawPost,
          );
          console.log("snapshot")
          console.log(snapshot)
          await this.repo.savePostSnapshot(snapshot);
        }
      } catch (error) {
        console.log(error)
        this.logger.error(
          `Failed to process post ${rawPost.postId} for profile ${profileId}: ${error.message}`,
          error.stack,
        );
        // Optionally, add to a failure list or queue for retry
      }
    }
  }

  /**
   * Helper to handle decryption logic for different platforms
   */
  private async getCredentials(profile: any): Promise<AuthCredentials> {
    const accessToken = await this.encryptionService.decrypt(
      profile.accessToken,
    );
    let accessSecret: string | undefined;

    // Twitter Specific Logic: Secret is in refresh_token field
    if (profile.platform === Platform.TWITTER) {
      if (profile.socialConnection.refreshToken) {
        accessSecret = await this.encryptionService.decrypt(
          profile.socialConnection.refreshToken,
        );
      } else {
        throw new Error('Twitter Access Secret missing in refresh_token field');
      }
    }

    return { accessToken, accessSecret };
  }
}
