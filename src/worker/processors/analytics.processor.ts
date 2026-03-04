import {
  AuthCredentials,
  FetchPostResult,
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

      this.logger.debug(`Fetching account stats for ${profile.platform}...`);
      const rawAccount = await this.fetcher.fetchAccountStats(
        profile.platform,
        profile.platformId,
        credentials,
      );

      // 1. ADD PLATFORM ARGUMENT HERE
      const accountPayload = await this.normalizer.normalizeAccountStats(
        profile.id,
        profile.platform, 
        rawAccount,
      );

      await this.repo.saveAccountAnalytics(accountPayload);

      await this.processPosts(
        profile.id,
        profile.platform,
        credentials,
        profile.platformId,
      );

      this.logger.log(`Analytics fetch completed for ${socialProfileId}`);
    } catch (error: any) {
      console.log(error);
      this.logger.error(`Analytics job failed: ${error.message}`);
      throw error;
    }
  }

  // ==========================================
  // HELPER METHODS
  // ==========================================

  private async processPosts(
    profileId: string,
    platform: Platform,
    credentials: AuthCredentials,
    pageId?: string, 
  ) {
    const postsToUpdate = await this.repo.getPostsForUpdate(profileId, 30);

    if (postsToUpdate.length === 0) return;

    const externalIds = postsToUpdate.map((p) => p.platformPostId);

    // 2. UPDATE TYPE HERE TO FetchPostResult
    let rawPosts: FetchPostResult[] = [];
    try {
      rawPosts = await this.fetcher.fetchPostStats(
        platform,
        externalIds,
        credentials,
        { pageId },
      );
    } catch (error: any) {
      console.log(error);
      this.logger.error(
        `Failed to fetch post stats for profile ${profileId}: ${error.message}`,
        error.stack,
      );
      // Return early if we entirely failed to fetch posts so we don't crash
      return; 
    }

    const postMap = new Map(postsToUpdate.map((p) => [p.platformPostId, p]));

    for (const rawPost of rawPosts) {
      try {
        // Extract the ID from the unified object
        const internalPost = postMap.get(rawPost.unified.postId);
        
        if (internalPost) {
          // 3. ADD PLATFORM ARGUMENT HERE
          const snapshot = this.normalizer.normalizePostStats(
            internalPost.id,
            platform,
            rawPost,
          );
          await this.repo.savePostSnapshot(snapshot);
        }
      } catch (error: any) {
        console.log(error);
        this.logger.error(
          `Failed to process post ${rawPost.unified.postId} for profile ${profileId}: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  private async getCredentials(profile: any): Promise<AuthCredentials> {
    const accessToken = await this.encryptionService.decrypt(
      profile.accessToken,
    );
    let accessSecret: string | undefined;

    if (profile.platform === 'TWITTER') {
      if (profile.connection?.refreshToken) {
        accessSecret = await this.encryptionService.decrypt(
          profile.connection.refreshToken,
        );
      } else {
        throw new Error('Twitter Access Secret missing in refresh_token field');
      }
    }

    return { accessToken, accessSecret };
  }
}