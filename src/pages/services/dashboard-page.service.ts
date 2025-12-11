import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  async getDashboard(orgId: string, daysCount: number = 30) {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const currentStart = new Date();
    currentStart.setDate(today.getDate() - daysCount);
    currentStart.setHours(0, 0, 0, 0);

    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - daysCount);

    const orgFilter = {
      OR: [
        { socialAccount: { organizationId: orgId } },
        { pageAccount: { socialAccount: { organizationId: orgId } } },
      ],
    };

    // Use labeled promises for clearer reading
    const queries = {
      currentFlow: this.prisma.accountAnalyticsDaily.aggregate({
        _sum: {
          reach: true,
          impressions: true,
          engagementCount: true,
          followersGained: true,
        },
        where: { date: { gte: currentStart, lte: today }, ...orgFilter },
      }),
      prevFlow: this.prisma.accountAnalyticsDaily.aggregate({
        _sum: { reach: true, impressions: true, engagementCount: true },
        where: { date: { gte: previousStart, lt: currentStart }, ...orgFilter },
      }),
      currentMaxFollowers: this.prisma.accountAnalyticsDaily.groupBy({
        by: ['socialAccountId', 'pageAccountId'],
        _max: { followersTotal: true },
        where: { date: { gte: currentStart, lte: today }, ...orgFilter },
      }),
      prevMaxFollowers: this.prisma.accountAnalyticsDaily.groupBy({
        by: ['socialAccountId', 'pageAccountId'],
        _max: { followersTotal: true },
        where: { date: { gte: previousStart, lt: currentStart }, ...orgFilter },
      }),
      currentPosts: this.prisma.post.count({
        where: {
          organizationId: orgId,
          status: 'PUBLISHED',
          publishedAt: { gte: currentStart, lte: today },
        },
      }),
      prevPosts: this.prisma.post.count({
        where: {
          organizationId: orgId,
          status: 'PUBLISHED',
          publishedAt: { gte: previousStart, lt: currentStart },
        },
      }),
      recentPosts: this.prisma.post.findMany({
        where: { organizationId: orgId, status: 'PUBLISHED' },
        orderBy: { publishedAt: 'desc' }, // Newest first
        take: 5,
        select: {
          id: true,
          content: true,
          platform: true,
          publishedAt: true,
          snapShots: {
            take: 1,
            orderBy: { recordedAt: 'desc' },
            select: {
              likes: true,
              comments: true,
              shares: true,
              impressions: true,
            },
          },
        },
      }),

      // --- H. UPCOMING SCHEDULED POSTS ---
      scheduledPosts: this.prisma.post.findMany({
        where: { organizationId: orgId, status: 'SCHEDULED' },
        orderBy: { scheduledAt: 'asc' }, // Soonest first
        take: 5,
        select: {
          id: true,
          content: true,
          platform: true,
          scheduledAt: true,
        },
      }),
    };

    // Execute Parallel
    const results = await Promise.all(Object.values(queries));

    // Map results back to keys
    const data = {
      currentFlow: results[0] as any,
      prevFlow: results[1] as any,
      currentMaxFollowers: results[2] as any[],
      prevMaxFollowers: results[3] as any[],
      currentPosts: results[4] as number,
      prevPosts: results[5] as number,
      recentPosts: results[6] as any[],
      scheduledPosts: results[7] as any[],
    };

    // Calculations
    const totalFollowersNow = data.currentMaxFollowers.reduce(
      (sum, item) => sum + (item._max.followersTotal || 0),
      0,
    );
    const totalFollowersPrev = data.prevMaxFollowers.reduce(
      (sum, item) => sum + (item._max.followersTotal || 0),
      0,
    );

    const currentEng = data.currentFlow._sum.engagementCount || 0;
    const currentImp = data.currentFlow._sum.impressions || 0;
    // Avoid division by zero
    const engagementRate =
      currentImp > 0 ? ((currentEng / currentImp) * 100).toFixed(2) : 0;

    const recentPostsFormatted = data.recentPosts.map((post) => {
      const stats = post.snapShots[0] || {
        likes: 0,
        comments: 0,
        shares: 0,
        impressions: 0,
      };
      return {
        id: post.id,
        platform: post.platform,
        content: post.content,
        publishedAt: post.publishedAt,
        thumbnail: post.mediaFiles[0]?.url || null,
        metrics: {
          likes: stats.likes,
          comments: stats.comments,
          shares: stats.shares,
          impressions: stats.impressions,
        },
      };
    });

    const scheduledPostsFormatted = data.scheduledPosts.map((post) => ({
      id: post.id,
      platform: post.platform,
      content: post.content,
      scheduledAt: post.scheduledAt,
    }));

    return {
      posts: {
        total: data.currentPosts,
        trend: this.calculateTrend(data.currentPosts, data.prevPosts),
        label: 'posts published',
      },
      followers: {
        total: totalFollowersNow,
        gained: data.currentFlow._sum.followersGained || 0,
        trend: this.calculateTrend(totalFollowersNow, totalFollowersPrev),
      },
      reach: {
        value: data.currentFlow._sum.reach || 0,
        trend: this.calculateTrend(
          data.currentFlow._sum.reach || 0,
          data.prevFlow._sum.reach || 0,
        ),
      },
      engagement: {
        total: currentEng,
        rate: engagementRate,
        trend: this.calculateTrend(
          currentEng,
          data.prevFlow._sum.engagementCount || 0,
        ),
      },
      widgets: {
        recent_posts: recentPostsFormatted,
        scheduled_posts: scheduledPostsFormatted,
      },
    };
  }

  private calculateTrend(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
  }
}