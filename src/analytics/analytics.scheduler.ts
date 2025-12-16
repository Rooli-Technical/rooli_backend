import { PrismaService } from "@/prisma/prisma.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { PostBatchJob, PageStatsJob } from "./interfaces/job-payload.interface";
import { Platform } from "@generated/enums";
import { AnalyticsService } from "./analytics.service";

@Injectable()
export class AnalyticsScheduler {
  private readonly logger = new Logger(AnalyticsScheduler.name);
  private readonly POST_BATCH_SIZE = 50; 
  private readonly MAX_POSTS_PER_HOUR = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsService: AnalyticsService,
    @InjectQueue('analytics') private analyticsQueue: Queue,
  ) {}

  /**
   * JOB 1: POST ANALYTICS SCHEDULER (Smart Polling)
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async schedulePostUpdates() {
    this.logger.log('Running Post Analytics Scheduler...');

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 1. Find posts due for update
    const duePosts = await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        platformPostId: { not: null },
        nextAnalyticsCheck: { lte: now }, // Due now or in past
        publishedAt: { gte: thirtyDaysAgo },
        platform: { in: [Platform.X, Platform.FACEBOOK, Platform.INSTAGRAM, Platform.LINKEDIN] },
      },
      select: {
        id: true,
        platformPostId: true,
        socialAccountId: true,
        pageAccountId: true,
        platform: true,
        analyticsPriority: true,
        socialAccount: { select: { id: true, isActive: true, organizationId: true } },
        pageAccount: { select: { id: true, isActive: true } }
      },
      orderBy: [
        { analyticsPriority: 'desc' },
        { nextAnalyticsCheck: 'asc' },
      ],
      take: this.MAX_POSTS_PER_HOUR,
    });

    if (duePosts.length === 0) return;

    // 2. Group by Unique Account Identity
    // We create a composite key so we can batch IDs for the exact same API credentials
    const grouped = new Map<string, typeof duePosts>();

    for (const post of duePosts) {
        // Skip inactive
        if (post.socialAccount && !post.socialAccount.isActive) continue;
        if (post.pageAccount && !post.pageAccount.isActive) continue;

        // Key: "PAGE-123-FACEBOOK" or "PROFILE-456-X"
        const key = post.pageAccountId 
            ? `PAGE:${post.pageAccountId}:${post.platform}`
            : `PROFILE:${post.socialAccountId}:${post.platform}`;

        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(post);
    }

    // 3. Create Batches
    let jobsCreated = 0;

    for (const [key, posts] of grouped.entries()) {
        const [type, accountId, platform] = key.split(':'); // Metadata from key

        // Helper: Chunk into 50s
        const chunks = this.chunkArray(posts, this.POST_BATCH_SIZE);

        for (let i = 0; i < chunks.length; i++) {
            const batch = chunks[i];
            const firstPost = batch[0];

            const payload: PostBatchJob = {
                batchNumber: i + 1,
                platform: platform as Platform,
                postIds: batch.map(p => p.platformPostId),
                organizationId: firstPost.socialAccount.organizationId,
                // Pass the IDs so processor knows where to look
                socialAccountId: type === 'PROFILE' ? accountId : undefined,
                pageAccountId: type === 'PAGE' ? accountId : undefined,
            };

            await this.analyticsQueue.add('fetch-post-metrics', payload, {
                removeOnComplete: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                // Use the highest priority found in this batch
                priority: Math.max(...batch.map(p => p.analyticsPriority || 1)),
            });
            jobsCreated++;
        }
    }

    this.logger.log(`Scheduled ${jobsCreated} batch jobs for ${duePosts.length} posts.`);
  }

  /**
   * JOB 2: PAGE ANALYTICS (Daily Growth)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async schedulePageUpdates() {
    this.logger.log('Running Daily Page Analytics Scheduler...');

   // -------------------------------------------------------
    // 1. PROCESS SOCIAL ACCOUNTS (Profiles)
    // -------------------------------------------------------
    // Targets: Twitter & LinkedIn (Personal)
    const socialAccounts = await this.prisma.socialAccount.findMany({
      where: { 
        isActive: true,
        // Query using the SocialPlatform Enum
        platform: { in: ['X', 'LINKEDIN'] } 
      },
      select: { id: true, platform: true, organizationId: true }
    });

    for (const acc of socialAccounts) {
      // Direct Mapping: TWITTER -> TWITTER
      // We cast the string to the Platform enum since they match names
      const jobPlatform = acc.platform === 'X' ? 'X' : 'LINKEDIN';

      await this.analyticsQueue.add('fetch-page-metrics', {
        targetId: acc.id,
        targetModel: 'PROFILE',
        platform: jobPlatform as Platform, 
        organizationId: acc.organizationId
      });
    }

    // -------------------------------------------------------
    // 2. PROCESS PAGE ACCOUNTS (Pages)
    // -------------------------------------------------------
    // Targets: Meta (FB/IG) & LinkedIn (Company)
    const pageAccounts = await this.prisma.pageAccount.findMany({
      where: { isActive: true },
      select: { 
        id: true, 
        // This likely returns 'META' or 'LINKEDIN'
        socialAccount: { select: { platform: true, organizationId: true } }, 
        // We need specific fields to know what jobs to spawn
        instagramBusinessId: true, 
        platformPageId: true 
      }
    });

    for (const page of pageAccounts) {
      const parentPlatform = page.socialAccount.platform; // e.g. 'META' or 'LINKEDIN'

      // CASE A: LINKEDIN COMPANY PAGE
      if (parentPlatform === 'LINKEDIN') {
        await this.analyticsQueue.add('fetch-page-metrics', {
          targetId: page.id,
          targetModel: 'PAGE',
          platform: 'LINKEDIN', 
          organizationId: page.socialAccount.organizationId
        });
      }

      // CASE B: META (The Special Logic)
      if (parentPlatform === 'META') {
        
        // Sub-Job 1: Facebook Page (Always exists if you have a PageAccount)
        if (page.platformPageId) {
          await this.analyticsQueue.add('fetch-page-metrics', {
            targetId: page.id,
            targetModel: 'PAGE',
            platform: 'FACEBOOK', // <--- Explicit Translation
            organizationId: page.socialAccount.organizationId
          });
        }

        // Sub-Job 2: Instagram Business (Only if linked)
        if (page.instagramBusinessId) {
          await this.analyticsQueue.add('fetch-page-metrics', {
            targetId: page.id,
            targetModel: 'PAGE',
            platform: 'INSTAGRAM', // <--- Explicit Translation
            organizationId: page.socialAccount.organizationId
          });
        }
      }
    }
  }

  // Helper
  private chunkArray<T>(array: T[], size: number): T[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
  }
}