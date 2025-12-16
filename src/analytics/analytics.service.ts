import { PrismaService } from '@/prisma/prisma.service';
import { Platform } from '@generated/enums';
import { Injectable, Logger } from '@nestjs/common';
import { PageMetrics } from './interfaces/page-metrics.interface';
import { PostMetrics } from './interfaces/post-metrics.interface';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * BATCH UPDATE: Updates multiple posts (e.g. 100 Tweets) in one Transaction.
   * This is much faster than looping one by one.
   */
  async updatePostMetrics(
    platform: Platform,
    metricsMap: Record<string, PostMetrics>,
    socialAccountId?: string,
  ) {
    const now = new Date();
    const platformPostIds = Object.keys(metricsMap);

    if (platformPostIds.length === 0) return;

    try {
      //  Fetch Posts 
      const posts = await this.prisma.post.findMany({
        where: {
          platformPostId: { in: platformPostIds },
          platform: platform,
          ...(socialAccountId ? { socialAccountId } : {}),
        },
        select: {
          id: true,
          platformPostId: true,
          publishedAt: true,
          currentImpressions: true,
        },
      });

      if (posts.length === 0) return;

      const postMap = new Map(posts.map((p) => [p.platformPostId, p]));
      const updates = [];

      for (const [platformPostId, metrics] of Object.entries(metricsMap)) {
        const post = postMap.get(platformPostId);
        if (!post) continue;

        // Smart Decay Calculation
        const nextCheck = this.calculateNextCheck(
          platform,
          post.publishedAt || new Date(),
        );

        // Engagement Rate Calculation
        const totalEngagement =
          metrics.likes + metrics.comments + metrics.shares;
        const engagementRate =
          metrics.impressions > 0
            ? (totalEngagement / metrics.impressions) * 100
            : 0;

        // Transaction Op A: Snapshot
        updates.push(
          this.prisma.postAnalyticsSnapshot.create({
            data: {
              postId: post.id,
              likes: metrics.likes,
              comments: metrics.comments,
              shares: metrics.shares,
              impressions: metrics.impressions,
              reach: metrics.reach || 0,
              clicks: metrics.clicks || 0,
              recordedAt: now,
            },
          }),
        );

        // Transaction Op B: Update Post 
        updates.push(
          this.prisma.post.update({
            where: { id: post.id },
            data: {
              currentLikes: metrics.likes,
              currentComments: metrics.comments,
              currentShares: metrics.shares,
              currentImpressions: metrics.impressions,
              currentReach: metrics.reach || 0,
              currentClicks: metrics.clicks || 0,
              engagementRate: engagementRate,

              lastAnalyticsCheck: now, 
              nextAnalyticsCheck: nextCheck,
            },
          }),
        );
      }

      // Execute Transaction
      if (updates.length > 0) {
        await this.prisma.$transaction(updates);
        this.logger.log(
          `Updated metrics for ${updates.length / 2} posts on ${platform}`,
        );

        // Update summary asynchronously (don't block)
        if (socialAccountId) {
          this.updateAccountAnalyticsSummary(socialAccountId, platform).catch(
            (e) => this.logger.error('Failed to update summary', e),
          );
        }
      }

      // REMOVED: The redundant updateMany block was deleted here.
    } catch (error) {
      this.logger.error('Error updating post metrics:', error);
      throw error;
    }
  }
  /**
   * PAGE UPDATE: Updates the Account/Page Growth stats.
   * Supports both SocialAccount (PROFILE) and PageAccount (PAGE)
   */
async updatePageMetrics(
    targetId: string,
    targetModel: 'PROFILE' | 'PAGE',
    platform: Platform,
    metrics: PageMetrics,
  ) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    try {
      // 1. ROBUST GROWTH CALCULATION
      // Don't check "Yesterday". Check the "Last Known Record" strictly before today.
      const lastRecord = await this.prisma.accountAnalytics.findFirst({
        where: {
          ...(targetModel === 'PROFILE' 
             ? { socialAccountId: targetId } 
             : { pageAccountId: targetId }),
          platform: platform,
          date: { lt: today }, // <--- STRICTLY LESS THAN TODAY
        },
        orderBy: { date: 'desc' }, // <--- GET MOST RECENT
      });

      // If no history exists (Day 1), gain is 0. 
      // If history exists, gain is Current - Previous.
      const previousFollowers = lastRecord?.followersTotal || 0;
      
      // Edge Case: If this is the VERY first run, don't show +1000 gained.
      // If lastRecord is null, we assume gained is 0 for the first entry.
      const followersGained = lastRecord 
        ? metrics.followers - previousFollowers 
        : 0; 
        
      const followersLost = followersGained < 0 ? Math.abs(followersGained) : 0;

      // 2. PREPARE OPERATIONS
      const txOperations = [];

      // Op A: Update Live Entity
      if (targetModel === 'PROFILE') {
        txOperations.push(
          this.prisma.socialAccount.update({
            where: { id: targetId },
            data: {
              followersCount: metrics.followers,
              followingCount: metrics.following || 0,
              lastPolledAt: new Date(),
            },
          }),
        );
      } else {
        txOperations.push(
          this.prisma.pageAccount.update({
            where: { id: targetId },
            data: {
              followersCount: metrics.followers,
              lastPolledAt: new Date(),
            },
          }),
        );
      }

      // Op B: Upsert History
      const analyticsData = {
        platform,
        date: today,
        followersTotal: metrics.followers,
        followersGained: followersGained > 0 ? followersGained : 0,
        followersLost: followersLost,
        impressions: metrics.pageImpressions || 0,
        profileViews: metrics.profileViews || 0,
        websiteClicks: metrics.websiteClicks || 0,
        // Helper to set the correct ID
        socialAccountId: targetModel === 'PROFILE' ? targetId : null,
        pageAccountId: targetModel === 'PAGE' ? targetId : null,
      };

      const uniqueWhere = targetModel === 'PROFILE'
        ? { socialAccountId_platform_date: { socialAccountId: targetId, platform, date: today } }
        : { pageAccountId_platform_date: { pageAccountId: targetId, platform, date: today } };

      txOperations.push(
        this.prisma.accountAnalytics.upsert({
          where: uniqueWhere as any, 
          update: analyticsData,
          create: analyticsData,
        }),
      );

      await this.prisma.$transaction(txOperations);
      
    } catch (error) {
      this.logger.error(`Error updating ${targetModel} metrics:`, error);
      throw error;
    }
  }

  /**
   * DASHBOARD QUERY: Get Overview Stats with performance optimizations
   */
  async getDashboardOverview(userId: string, dateFrom: Date, dateTo: Date) {
    try {
      // Use Promise.all with optimized queries
      const [accountStats, postStats, topPosts] = await Promise.all([
        // Account analytics aggregation
        this.prisma.accountAnalytics.aggregate({
          _sum: {
            impressions: true,
            profileViews: true,
            websiteClicks: true,
            followersGained: true,
            engagementCount: true,
          },
          where: {
            OR: [
              { socialAccount: { userId, isActive: true } },
              { pageAccount: { socialAccount: { userId, isActive: true } } },
            ],
            date: { gte: dateFrom, lte: dateTo },
          },
        }),

        // Post engagement aggregation
        this.prisma.post.aggregate({
          _sum: {
            currentLikes: true,
            currentComments: true,
            currentShares: true,
            currentImpressions: true,
            currentReach: true,
            currentClicks: true,
          },
          _avg: {
            engagementRate: true,
          },
          where: {
            userId: userId,
            status: 'PUBLISHED',
            publishedAt: { gte: dateFrom, lte: dateTo },
          },
        }),

        // Top performing posts
        this.prisma.post.findMany({
          where: {
            userId: userId,
            status: 'PUBLISHED',
            publishedAt: { gte: dateFrom, lte: dateTo },
            currentImpressions: { gt: 0 }, // Filter out posts with no impressions
          },
          select: {
            id: true,
            content: true,
            platform: true,
            currentLikes: true,
            currentComments: true,
            currentShares: true,
            currentImpressions: true,
            engagementRate: true,
            publishedAt: true,
          },
          orderBy: { engagementRate: 'desc' },
          take: 5,
        }),
      ]);

      const totalEngagement =
        (postStats._sum.currentLikes || 0) +
        (postStats._sum.currentComments || 0) +
        (postStats._sum.currentShares || 0);

      return {
        // Account metrics
        totalImpressions: accountStats._sum.impressions || 0,
        totalProfileViews: accountStats._sum.profileViews || 0,
        totalWebsiteClicks: accountStats._sum.websiteClicks || 0,
        totalFollowersGained: accountStats._sum.followersGained || 0,
        totalEngagementCount: accountStats._sum.engagementCount || 0,

        // Post metrics
        totalLikes: postStats._sum.currentLikes || 0,
        totalComments: postStats._sum.currentComments || 0,
        totalShares: postStats._sum.currentShares || 0,
        totalPostImpressions: postStats._sum.currentImpressions || 0,
        totalPostReach: postStats._sum.currentReach || 0,
        totalPostClicks: postStats._sum.currentClicks || 0,
        averageEngagementRate: postStats._avg.engagementRate || 0,

        // Derived metrics
        totalEngagement: totalEngagement,
        engagementRate: postStats._sum.currentImpressions
          ? (totalEngagement / postStats._sum.currentImpressions) * 100
          : 0,

        // Top posts
        topPerformingPosts: topPosts,
      };
    } catch (error) {
      this.logger.error('Error fetching dashboard overview:', error);
      throw error;
    }
  }

  /**
   * Helper: Update account analytics summary
   */
  private async updateAccountAnalyticsSummary(
    socialAccountId: string,
    platform: Platform,
  ) {
    // Update weekly/monthly summaries or cache
    // Implementation depends on your requirements
  }

  /**
   * Smart decay logic for next analytics check
   */
  private calculateNextCheck(platform: Platform, publishedAt: Date): Date {
    const now = new Date();

    // Twitter: Fixed 24-hour intervals
    if (platform === Platform.X) {
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }

    // For other platforms: Smart decay based on post age
    const ageInHours = Math.max(
      0,
      (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60),
    );

    let intervalHours: number;

    if (ageInHours < 24) {
      // First 24 hours: Check every 2 hours
      intervalHours = 2;
    } else if (ageInHours < 72) {
      // 1-3 days: Check every 6 hours
      intervalHours = 6;
    } else if (ageInHours < 168) {
      // 3-7 days: Check every 12 hours
      intervalHours = 12;
    } else if (ageInHours < 720) {
      // 7-30 days: Check every 24 hours
      intervalHours = 24;
    } else {
      // Over 30 days: Check weekly
      intervalHours = 168; // 7 days
    }

    // Platform-specific adjustments
    switch (platform) {
      case Platform.INSTAGRAM:
        // Instagram metrics update quickly initially
        if (ageInHours < 48) intervalHours = Math.max(1, intervalHours * 0.5);
        break;
      case Platform.LINKEDIN:
        // LinkedIn metrics stabilize slower
        intervalHours = Math.min(intervalHours * 1.5, 48);
        break;
    }

    return new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
  }
}
