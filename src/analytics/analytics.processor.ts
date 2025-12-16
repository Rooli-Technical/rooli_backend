import { EncryptionService } from '@/common/utility/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalyticsService } from './analytics.service';
import { PageStatsJob, PostBatchJob } from './interfaces/job-payload.interface';
import { PlatformService } from './platform.service';
import { AuthContext } from './interfaces/analytics.interface';
import { Platform } from '@generated/enums';


@Processor('analytics', {
  // MOVE 'limiter' HERE
  limiter: {
    max: 5,         // Max 5 jobs
    duration: 1000, // Per 1000ms (1 second)
  },
  concurrency: 1} // Optional: How many jobs to process in parallel (usually 1 if rate limiting)
  )
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsService: AnalyticsService,
    private readonly platformService: PlatformService,
    private readonly encryptionService: EncryptionService,
  ) {
    super();
  }

  async process(job: Job) {
    this.logger.debug(`Processing ${job.name} (${job.id})`);

    try {
      switch (job.name) {
        case 'fetch-post-metrics':
          return await this.handlePostMetrics(job.data as PostBatchJob);
        case 'fetch-page-metrics':
          return await this.handlePageMetrics(job.data as PageStatsJob);
        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      this.logger.error(`Job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  // --- HANDLERS ---

  private async handlePostMetrics(data: PostBatchJob) {
    // 1. Resolve Credentials (with Decryption)
    const context = await this.resolveAuthContext(
      data.platform,
      data.socialAccountId, 
      data.pageAccountId
    );

    // 2. Fetch Data from Platform API
    const metricsMap = await this.platformService.fetchPostMetrics(
      data.platform,
      context.auth,
      data.postIds,
    );

    // 3. Update Database
    await this.analyticsService.updatePostMetrics(
      data.platform,
      metricsMap,
      data.socialAccountId // Optional logging context
    );

    return { processed: Object.keys(metricsMap).length };
  }

  private async handlePageMetrics(data: PageStatsJob) {
    // 1. Resolve Credentials
    const context = await this.resolveAuthContext(
      data.platform,
      data.targetModel === 'PROFILE' ? data.targetId : undefined, // socialAccountId
      data.targetModel === 'PAGE' ? data.targetId : undefined     // pageAccountId
    );

    // 2. Fetch Data
    const metrics = await this.platformService.fetchPageMetrics(
      data.platform,
      context.auth,
    );

    // 3. Update Database
    await this.analyticsService.updatePageMetrics(
      data.targetId,
      data.targetModel,
      data.platform,
      metrics,
    );

    return { followers: metrics.followers };
  }

  // --- THE TOKEN RESOLVER (CRITICAL LOGIC) ---

  private async resolveAuthContext(
    platform: Platform,
    socialAccountId?: string,
    pageAccountId?: string,
  ): Promise<{ auth: AuthContext; platformId: string }> {
    
    // SCENARIO A: It's a Page (FB, IG, LinkedIn Company)
    if (pageAccountId) {
      const page = await this.prisma.pageAccount.findUnique({
        where: { id: pageAccountId },
        include: { socialAccount: true }, // <--- Critical: Join Parent for LinkedIn fallback
      });

      if (!page) throw new Error(`Page ${pageAccountId} not found`);

     // 1. DECIDE WHICH ID TO USE
      let apiTargetId = page.platformPageId; // Default to FB Page ID

      // If the JOB says Instagram, we MUST use the IG Business ID
      if (platform === 'INSTAGRAM') {
         // Safety check: The PageAccount might be 'META', but does it have IG?
         if (!page.instagramBusinessId) {
           throw new Error(`PageAccount ${page.id} (Meta) has no instagramBusinessId, but job requested INSTAGRAM analytics`);
         }
         apiTargetId = page.instagramBusinessId;
      }
      // 2. DECIDE WHICH TOKEN TO USE
      let tokenToUse = page.accessToken;

      if (platform === 'LINKEDIN' && page.socialAccount) {
        tokenToUse = page.socialAccount.accessToken;
      }

      const accessToken = await this.encryptionService.decrypt(tokenToUse);

     return {
        platformId: apiTargetId, 
        auth: {
          platformAccountId: apiTargetId,
          accessToken,
          tokenSecret: undefined
        }
      };
    }

    // SCENARIO B: It's a Profile (Twitter User, LinkedIn Person)
    if (socialAccountId) {
      const account = await this.prisma.socialAccount.findUnique({
        where: { id: socialAccountId },
      });

      if (!account) throw new Error(`Account ${socialAccountId} not found`);

      const accessToken = await this.encryptionService.decrypt(account.accessToken);
      const tokenSecret = account.accessSecret 
        ? await this.encryptionService.decrypt(account.accessSecret) 
        : undefined;

      return {
        platformId: account.platformAccountId,
        auth: {
          platformAccountId: account.platformAccountId,
          accessToken,
          tokenSecret,
        }
      };
    }

    throw new Error('No account ID provided for context resolution');
  }

  // --- ERROR HANDLING ---
  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    this.logger.warn(`Job ${job.name} failed. Error: ${error.message}`);
    // You can add specific alert logic here (e.g., Slack notification)
  }
}