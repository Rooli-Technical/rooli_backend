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

    // A. Profiles (X, LinkedIn Personal)
    const profiles = await this.prisma.socialAccount.findMany({
        where: { 
            isActive: true, 
            platform: { in: [Platform.X, Platform.LINKEDIN] } // Add others if needed
        },
        select: { id: true, platform: true, organizationId: true }
    });

    for (const p of profiles) {
        await this.analyticsQueue.add('fetch-page-metrics', {
            targetId: p.id,
            targetModel: 'PROFILE',
            platform: p.platform,
            organizationId: p.organizationId
        } as PageStatsJob, { 
            removeOnComplete: true,
            // Stagger X requests slightly to avoid heavy bursts
            delay: p.platform === 'X' ? Math.floor(Math.random() * 60000) : 0
        });
    }

    // B. Pages (FB, IG, LinkedIn Company)
    const pages = await this.prisma.pageAccount.findMany({
        where: { isActive: true },
        select: { 
            id: true, 
            platform: true, 
            socialAccount: { select: { organizationId: true } } 
        }
    });

    for (const p of pages) {
        await this.analyticsQueue.add('fetch-page-metrics', {
            targetId: p.id,
            targetModel: 'PAGE',
            platform: p.platform,
            organizationId: p.socialAccount.organizationId
        } as PageStatsJob, { removeOnComplete: true });
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